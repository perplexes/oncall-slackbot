/*jslint node: true */
/*globals module: true */

var oncallsParams = {
  "time_zone": 'UTC',
  "include[]": 'users',
  "schedule_ids[]" : {}
};

//
var request = require('request');
var async = require('async');
var _ = require('underscore');
var querystring = require('querystring');
var debug = require('debug')('pagerduty');
const NodeCache = require( "node-cache" );

/**
 * params object:
 *   domain: String (required)
 *   token: String (required)
 *
 **/
var PagerDuty = function (options) {
  this.headers = {'Accept': 'application/vnd.pagerduty+json;version=2', 'Content-Type': 'application/json', 'Authorization': 'Token token=' + options.pagerduty_token};
  this.endpoint = "https://api.pagerduty.com";
  this.cache = new NodeCache();
  oncallsParams["schedule_ids[]"] = options.schedule_ids;
  this.token = options.pagerduty_token;
  this.cacheInterval = options.cache_interval_seconds;
  this.fromEmail = options.from_email || '';
};

PagerDuty.prototype.getAllPaginatedData = function (options) {
  options.params = options.params || {};
  options.params.limit = 100; // 100 is the max limit allowed by pagerduty
  options.params.offset = 0;

  var total = null,
    items = [],
    items_map = {},
    self = this,
    requestOptions = {
      headers: self.headers,
      json: true,
      total: true
    };

  var pagedCallback = function (error, content) {
    if (error) {
      debug("Issues with pagedCallback: " + error);
      return options.callback(error);
    }

    if (!content || !content[options.contentIndex]) {
      error = "Page does not have valid data: " + JSON.stringify(content);
      debug(error);
      return options.callback(new Error(error));
    }

    if (content[options.contentIndex].length > 0) {
      items = items.concat(content[options.contentIndex]);
    }

    options.params.offset = content.offset + content.limit; // Update the offset for the next paging request
    total = content.total;

    // Index the results as a map from id: item
    if (options.sortBy) {
      items.sort(function(a,b) {
        return a[options.sortBy] - b[options.sortBy];
      });
    }

    _.each(items, function(item, i) {
      index = item.id || item[options.secondaryIndex].id;
      if(options.sortBy) {
        index = item[options.sortBy] + '-' + index;
      }
      items_map[index] = item;
    });

    if (options.params.offset >= total) {
      options.callback(error, items_map);
    } else {
      requestAnotherPage();
    }
  };

  var requestAnotherPage = function () {
    // must use node's built in querystring since qs doesn't build arrays like PagerDuty expects.
    requestOptions.url = self.endpoint + options.uri + "?" + querystring.stringify(options.params);

    request(requestOptions, function (error, response, body) {
      if (!error && response.statusCode == 200) {
        pagedCallback(null, body);
      } else {
        pagedCallback(error);
      }
    });
  };

  requestAnotherPage();
};

PagerDuty.prototype.getOnCalls = function (params, callback) {
  var options = {contentIndex: "oncalls", secondaryIndex: 'user', sortBy: 'escalation_level', uri: "/oncalls", callback: callback, params: params || oncallsParams };
  var self = this;
  async.auto({
    getCacheData: function(cb) {
      debug("getCacheData");
      self.cache.get(options.contentIndex, cb);
    },
    checkCacheData: ['getCacheData', function (results, cb) {
      debug("checkCacheData");
      if (results.getCacheData == undefined) {
        options.callback = cb;
        self.getAllPaginatedData(options);
      } else {
        callback(null, results.getCacheData);
      }
    }],
    setCacheData: ['checkCacheData', function (results, cb) {
      debug("setCacheData");
      var cacheableResult = results.checkCacheData;
      self.cache.set(options.contentIndex, cacheableResult, self.cacheInterval, cb(null,cacheableResult));
    }]
  }, function(err, result) {
    callback(null, result.setCacheData);
  });
};

/**
 * Resolve the service ID by walking: oncalls -> escalation_policy -> services.
 * Caches the result so we only do this lookup once.
 */
PagerDuty.prototype.resolveServiceId = function (callback) {
  var self = this;
  var cached = self.cache.get('serviceId');
  if (cached) {
    return callback(null, cached);
  }

  self.getOnCalls(null, function (err, oncalls) {
    if (err) return callback(err);

    var firstEntry = _.find(oncalls, function () { return true; });
    if (!firstEntry || !firstEntry.escalation_policy) {
      return callback(new Error('No escalation policy found in oncalls data'));
    }

    var epId = firstEntry.escalation_policy.id;
    debug('Resolved escalation policy: ' + epId);

    var qs = querystring.stringify({"escalation_policy_ids[]": epId});
    request.get({
      url: self.endpoint + '/services?' + qs,
      headers: self.headers,
      json: true
    }, function (error, response, body) {
      if (error) return callback(error);
      if (response.statusCode !== 200 || !body.services || body.services.length === 0) {
        return callback(new Error('No service found for escalation policy ' + epId));
      }
      var serviceId = body.services[0].id;
      debug('Resolved service: ' + serviceId);
      self.cache.set('serviceId', serviceId, self.cacheInterval);
      callback(null, serviceId);
    });
  });
};

PagerDuty.prototype.createIncident = function (title, callback) {
  var self = this;

  if (!self.fromEmail) {
    return callback(new Error('pagerduty.from_email is not configured'));
  }

  self.resolveServiceId(function (err, serviceId) {
    if (err) return callback(err);

    var headers = _.extend({}, self.headers, {'From': self.fromEmail});

    request.post({
      url: self.endpoint + '/incidents',
      headers: headers,
      json: true,
      body: {
        incident: {
          type: 'incident',
          title: title,
          service: {
            id: serviceId,
            type: 'service_reference'
          }
        }
      }
    }, function (error, response, body) {
      if (error) {
        debug('createIncident error: ' + error);
        return callback(error);
      }
      if (response.statusCode !== 201) {
        var msg = (body && body.error && body.error.message) || ('HTTP ' + response.statusCode);
        debug('createIncident failed: ' + msg);
        return callback(new Error(msg));
      }
      debug('createIncident success: ' + body.incident.id);
      callback(null, body.incident);
    });
  });
};

module.exports = PagerDuty;