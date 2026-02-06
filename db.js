var Database = require('better-sqlite3');
var path = require('path');
var debug = require('debug')('db');

var db = new Database(path.join(__dirname, 'oncall.db'));

db.pragma('journal_mode = WAL');

db.exec(
  'CREATE TABLE IF NOT EXISTS channel_links (' +
  '  channel_id TEXT PRIMARY KEY,' +
  '  channel_name TEXT,' +
  '  schedule_id TEXT NOT NULL,' +
  '  created_by TEXT,' +
  '  created_at TEXT DEFAULT CURRENT_TIMESTAMP' +
  ')'
);

var linkStmt = db.prepare(
  'INSERT OR REPLACE INTO channel_links (channel_id, channel_name, schedule_id, created_by, created_at) ' +
  'VALUES (?, ?, ?, ?, datetime(\'now\'))'
);

var unlinkStmt = db.prepare('DELETE FROM channel_links WHERE channel_id = ?');
var getStmt = db.prepare('SELECT * FROM channel_links WHERE channel_id = ?');
var allStmt = db.prepare('SELECT * FROM channel_links ORDER BY channel_name');

module.exports = {
  link: function (channelId, channelName, scheduleId, userId) {
    linkStmt.run(channelId, channelName, scheduleId, userId);
    debug('Linked #' + channelName + ' (' + channelId + ') to schedule ' + scheduleId);
  },

  unlink: function (channelId) {
    var result = unlinkStmt.run(channelId);
    debug('Unlinked channel ' + channelId + ' (changes: ' + result.changes + ')');
    return result.changes > 0;
  },

  getSchedule: function (channelId) {
    return getStmt.get(channelId);
  },

  getAllLinks: function () {
    return allStmt.all();
  }
};
