/**
 * OnCall #slack bot that integrates with PagerDuty
 *
 * TODO notify all the channels that have invited the bot that there might have been a change in command
 *
 */

var config = require('config');
var pjson = require('./package.json');
var async = require('async');
var debug = require('debug')('oncall_bot');
var _ = require('underscore');
var request = require('request');

var SlackBot = require('slackbots');

const NodeCache = require("node-cache");
var cache = new NodeCache();
var cacheInterval = config.get("slack.cache_interval_seconds");
var nextInQueueInterval = config.get("slack.next_in_queue_interval");

var PagerDuty = require('./pagerduty.js');
var pagerDuty = new PagerDuty(config.get('pagerduty'));

var db = require('./db.js');

// create a bot
var bot = new SlackBot({
  token: config.get('slack.slack_token'), // Add a bot https://my.slack.com/services/new/bot and put the token
  name: config.get('slack.bot_name')
});
var iconEmoji = config.get('slack.emoji');
var testUser = config.get('slack.test_user');

// getUser constants
const FIND_BY_ID = 0;
const FIND_BY_EMAIL = 1;
const FIND_BY_NAME = 2;

// commands
const HELP_REGEX = new RegExp('^[hH]elp$');
const WHO_REGEX = new RegExp('^[wW]ho$');
const VERSION_REGEX = new RegExp('^[vV]ersion$');
const LINK_REGEX = /^link\s+<#([^|>]+)(?:\|([^>]*))?>(?:\s+)<?([^\s>]+)>?$/i;
const UNLINK_REGEX = /^unlink\s+<#([^|>]+)(?:\|([^>]*))?>$/i;
const LIST_REGEX = /^list$/i;

/**
 * Parse a PagerDuty schedule ID from a URL or raw ID.
 *
 * Accepts:
 *   https://company.pagerduty.com/schedules#PXXXXXX
 *   https://company.pagerduty.com/schedules/PXXXXXX
 *   PXXXXXX
 */
function parseScheduleId(input) {
  var match = input.match(/schedules[#\/]([A-Za-z0-9]+)/);
  if (match) return match[1];
  if (/^[A-Za-z0-9]+$/.test(input)) return input;
  return null;
}

/**
 * Try to join a Slack channel using the Web API.
 */
function joinChannel(channelId, callback) {
  request.post({
    url: 'https://slack.com/api/conversations.join',
    json: true,
    headers: { 'Authorization': 'Bearer ' + config.get('slack.slack_token') },
    body: { channel: channelId }
  }, function (err, response, body) {
    if (err) return callback(err);
    if (body && !body.ok) return callback(new Error(body.error || 'unknown slack error'));
    callback(null, body);
  });
}

/**
 * Build PagerDuty oncall params for a specific schedule.
 */
function buildScheduleParams(scheduleId) {
  return {
    "time_zone": 'UTC',
    "include[]": 'users',
    "schedule_ids[]": [scheduleId]
  };
}

/**
 * Resolve the schedule IDs for a given channel.
 *
 * If the channel has a linked schedule in the DB, use that.
 * Otherwise fall back to global config schedule_ids.
 * Returns null if no schedules are configured anywhere.
 */
function resolveScheduleParams(channelId) {
  var link = db.getSchedule(channelId);
  if (link) {
    return buildScheduleParams(link.schedule_id);
  }
  var globalIds = config.get('pagerduty.schedule_ids');
  if (globalIds && globalIds.length > 0 && globalIds[0] !== '') {
    return null; // null tells getOnCalls to use default oncallsParams
  }
  return undefined; // no schedules at all
}

/**
 * Send a message to the oncall people.
 *
 * @param message
 */
var messageOnCalls = function (message) {
  getOnCallSlackers(null, function (slackers) {
    _.each(slackers, function (slacker) {
      debug('POST MESSAGE TO: ' + slacker);
      bot.postMessageToUser(testUser || slacker, message, {icon_emoji: iconEmoji});
    })
  });
};

/**
 * Mention oncall people in a channel.
 *
 * @param channel
 * @param message
 * @param scheduleParams
 */
var mentionOnCalls = function (channel, message, scheduleParams) {
  var usersToMention = '';
  getOnCallSlackers(scheduleParams, function (slackers) {
    _.each(slackers, function (slacker) {
      usersToMention += '<@' + (testUser || slacker) + '> ';
    });
    bot.postMessageToChannel(channel, usersToMention.trim() + ', ' + message, {icon_emoji: iconEmoji});
  });
};


/**
 * Post message with reference to on call peeps
 *
 * @param obj
 * @param preMessage
 * @param postMessage
 * @param direct
 * @param scheduleParams
 */
var postMessage = function (obj, preMessage, postMessage, direct, scheduleParams) {
  var usersToMention = '';
  getOnCallSlackers(scheduleParams, function (slackers) {
    _.each(slackers, function (slacker) {
      usersToMention += '<@' + (testUser || slacker) + '> ';
    });
    var message = ' ' + usersToMention.trim() + ' ' + postMessage;
    if(direct) {
      bot.postMessageToUser(obj, message, {icon_emoji: iconEmoji});
    } else {
      bot.postMessage(obj, message, {icon_emoji: iconEmoji});
    }
  });
};

/**
 * Get the channels and cache 'em
 *
 * @param callback
 */
var cacheChannels = function (callback) {
  bot.getChannels().then(function (data) {
    debug("Caching channels");
    async.each(data, function (channel, cb) {
      debug("channel: " + JSON.stringify(channel));
      cb();
    }, function (err) {
      if (err) {
        debug(err);
      } else {
        cache.set('channels', data, cacheInterval, callback);
      }
    });
  });
};

/**
 * Get the users and cache 'em.
 *
 * @param callback
 */
var cacheUsers = function (callback) {
  bot.getUsers().then(function (data) {
    async.each(data.members, function (user, each_cb) {
      debug("Caching user name/id: " + user.name);

      async.parallel([
        function (cb) {
          cache.set(user.name, user, cacheInterval, cb);
        },
        function (cb) {
          cache.set('ID:' + user.id, user, cacheInterval, cb);
        }
      ], each_cb);
    }, function (err) {
      if (err) {
        debug(err);
        callback(err);
      } else {
        cache.set('users', data, cacheInterval, callback);
      }
    });
  });
};

/**
 * Get a channel by id
 *
 * @param channelId
 * @param callback
 */
var getChannel = function (channelId, callback) {
  cache.get('channels', function (err, channelObj) {
    if (channelObj == undefined) {
      cb = function (err, results) {
        getChannel(channelId, callback);
      };

      cacheChannels(cb);
    } else {
      var channel = _.find(channelObj.channels, function (channel) {
        return channel.id == channelId;
      });
      callback(channel);
    }
  });
};

/**
 * Just get the users.
 *
 * @param findBy  constant to use for searching
 * @param value value to search by
 * @param callback
 */
var getUser = function (findBy, value = '', callback) {
  if (findBy == FIND_BY_EMAIL && value.indexOf('@') > 0) {
    cache.get('users', function (err, userObj) {
      if (userObj == undefined) {
        cb = function (err, results) {
          getUser(findBy, value, callback);
        };

        cacheUsers(cb);
      } else {
        var member = undefined;

        if (findBy == FIND_BY_EMAIL) {
          member = _.find(userObj.members, function (member) {
            return member.profile.email == value
          });
        }
        callback(!member ? value + " not mapped to user" : null, member);
      }
    });
  } else if (findBy == FIND_BY_ID && value.indexOf('U') == 0 && value.length == 9) {
    cache.get('ID:' + value, function (err, userObj) {
      if (userObj == undefined) {
        cb = function (err, results) {
          getUser(findBy, value, callback);
        };

        cacheUsers(cb);
      } else {
        callback(!userObj ? value + " not mapped to user" : null, userObj);
      }
    });
  } else if (findBy == FIND_BY_NAME && !(value.indexOf('U') == 0 && value.length == 9)) {
    cache.get(value, function (err, userObj) {
      if (userObj == undefined) {
        cb = function (err, results) {
          getUser(findBy, value, callback);
        };

        cacheUsers(cb);
      } else {
        callback(!userObj ? value + " not mapped to user" : null, userObj);
      }
    });
  }
};
/**
 * Return who's on call.
 *
 * @param scheduleParams  PagerDuty params with schedule_ids, or null for global default
 * @param callback
 */
var getOnCallSlackers = function (scheduleParams, callback) {
  var oncallSlackers = [];
  pagerDuty.getOnCalls(scheduleParams, function (err, pdUsers) {

    async.each(pdUsers, function (pdUser, cb) {
      getUser(FIND_BY_EMAIL, pdUser.user.email, function (err, slacker) {
        oncallSlackers.push(slacker.id);
        cb();
      });
    }, function (err) {
      if (err) {
        debug(err);
      } else {
        callback(oncallSlackers);
      }
    });
  })
};

/**
 * TBD
 * @param channel
 * @param user
 * @param callback
 */
var storeMention = function (channel, user, callback) {

};

/**
 * TBD
 * @param channel
 * @param user
 * @param callback
 */
var clearStoredMention = function (channel, user, callback) {

};

/**
 *  Start the bot
 */
bot.on('start', function () {

  async.series([
    function (callback) {
      cacheUsers(callback);
    },
    function (callback) {
      cacheChannels(callback);
    },
    function (callback) {
      getOnCallSlackers(null, callback);
    }
  ], function () {
    var msg = config.get('slack.welcome_message').trim();
    if (msg.length > 0) {
      messageOnCalls(config.get('slack.welcome_message'));
    }
  });
});

bot.on('message', function (data) {
    // all ingoing events https://api.slack.com/rtm
    if (data.type == 'message') {
      var notABot = (data.bot_id == undefined);
      var message = data.text ? data.text.trim() : '';

      var botTag = '<@' + bot.self.id + '>';
      var botTagIndex = message.indexOf(botTag);

      // check if we need to look up a bot by it's username
      var username = '';
      var enableBotBotComm= false;
      if (botTagIndex <= 0 && message.indexOf('<@') == 0) {
        var userNameData = message.match(/^<@(.*?)>/g);
        username = (userNameData && userNameData[0].replace(/[<@>]/g,''));
        getUser(FIND_BY_NAME, username, function(err, user) {
          if (user && user.is_bot) {
            botTag = '<@' + user.id + '>';
            enableBotBotComm = true;
          }
        });
      }

      // handle normal channel interaction
      if ( (notABot || data.bot_id != bot.self.id)
        && (botTagIndex >= 0 || enableBotBotComm) ) {
        getChannel(data.channel, function (channel) {
          if (channel) {
            var scheduleParams = resolveScheduleParams(data.channel);
            if (scheduleParams === undefined) {
              debug('No schedule configured for channel ' + channel.name);
              return;
            }

            if (message.match(new RegExp('^' + botTag + ':? who$'))) { // who command
              postMessage(data.channel, '', 'are the humans OnCall.', false, scheduleParams);
            }
            else if (message.match(new RegExp('^' + botTag + ':?$'))) { // need to support mobile which adds : after a mention
              mentionOnCalls(channel.name, "get in here! :point_up_2:", scheduleParams);
            }
            else {  // default
              preText = (data.user ? ' <@' + data.user + '>' : botTag) +  ' said _"';
              if (botTagIndex == 0) {
                mentionOnCalls(channel.name, preText + message.substr(botTag.length + 1) + '_"', scheduleParams);
              } else if (data.user || enableBotBotComm) {
                message = message.replace(/^<@(.*?)> +/,'');  // clean up spacing
                mentionOnCalls(channel.name, preText + message + '_"', scheduleParams);
              }
            }
          }
        });
      }
      // handle direct bot interaction
      else if (notABot) {
        getChannel(data.channel, function (channel) {
          if(!channel) {
            getUser(FIND_BY_ID, data.user, function (err, user) {
              if (err) {
                debug(err);
              } else {
                // link command
                var linkMatch = message.match(LINK_REGEX);
                if (linkMatch) {
                  var channelId = linkMatch[1];
                  var channelName = linkMatch[2] || channelId;
                  var scheduleInput = linkMatch[3];
                  var scheduleId = parseScheduleId(scheduleInput);

                  if (!scheduleId) {
                    bot.postMessageToUser(user.name,
                      "I couldn't parse a schedule ID from that. Try a PagerDuty schedule URL or a raw schedule ID like `PXXXXXX`.",
                      {icon_emoji: iconEmoji});
                    return;
                  }

                  db.link(channelId, channelName, scheduleId, data.user);

                  joinChannel(channelId, function (err) {
                    if (err) {
                      debug('Failed to join channel ' + channelName + ': ' + err.message);
                      bot.postMessageToUser(user.name,
                        'Linked <#' + channelId + '> to PagerDuty schedule `' + scheduleId + '`. ' +
                        "I couldn't join the channel automatically — please invite me with `/invite @" + config.get('slack.bot_name') + "`.",
                        {icon_emoji: iconEmoji});
                    } else {
                      bot.postMessageToUser(user.name,
                        'Linked <#' + channelId + '> to PagerDuty schedule `' + scheduleId + '`. I\'ve joined the channel.',
                        {icon_emoji: iconEmoji});
                    }
                  });
                  return;
                }

                // unlink command
                var unlinkMatch = message.match(UNLINK_REGEX);
                if (unlinkMatch) {
                  var channelId = unlinkMatch[1];
                  var channelName = unlinkMatch[2] || channelId;

                  if (db.unlink(channelId)) {
                    bot.postMessageToUser(user.name,
                      'Unlinked <#' + channelId + '>. I\'ll no longer respond to @oncall there (unless a global schedule is configured).',
                      {icon_emoji: iconEmoji});
                  } else {
                    bot.postMessageToUser(user.name,
                      '<#' + channelId + '> wasn\'t linked to any schedule.',
                      {icon_emoji: iconEmoji});
                  }
                  return;
                }

                // list command
                if (message.match(LIST_REGEX)) {
                  var links = db.getAllLinks();
                  if (links.length === 0) {
                    bot.postMessageToUser(user.name,
                      'No channels are linked to PagerDuty schedules yet. Use `link #channel <schedule>` to set one up.',
                      {icon_emoji: iconEmoji});
                  } else {
                    var lines = links.map(function (l) {
                      return '• <#' + l.channel_id + '> → `' + l.schedule_id + '`';
                    });
                    bot.postMessageToUser(user.name,
                      '*Linked channels:*\n' + lines.join('\n'),
                      {icon_emoji: iconEmoji});
                  }
                  return;
                }

                if (message.match(WHO_REGEX)) { // who command
                  postMessage(user.name, '', 'are the humans OnCall.', true, null);
                }
                else if (message.match(VERSION_REGEX)) { // version command
                  bot.postMessageToUser(user.name, 'I am *' + pjson.name + '* and running version ' + pjson.version + '.', {icon_emoji: iconEmoji});
                }
                else if (message.match(HELP_REGEX)) { // help command
                  bot.postMessageToUser(user.name,
                    'I understand these commands:\n' +
                    '• *help* — this message\n' +
                    '• *who* — show who\'s on call\n' +
                    '• *version* — show bot version\n' +
                    '• *link #channel <schedule URL or ID>* — connect a channel to a PagerDuty schedule\n' +
                    '• *unlink #channel* — disconnect a channel\n' +
                    '• *list* — show all linked channels',
                    {icon_emoji: iconEmoji});
                }
              }
            });
          }
        });
      }
    }
  }
);
