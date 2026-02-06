# oncall-slackbot

Stop pinging people by name. Ping the rotation.

**oncall-slackbot** connects [Slack](https://slack.com/) to [PagerDuty](https://www.pagerduty.com/) so your team can mention `@oncall` in any channel and reach whoever is currently on-call — no guessing, no outdated bookmarks, no "sorry, I'm off rotation."

## How It Works

| In a channel | In a DM with the bot |
|---|---|
| `@oncall` — summons on-call engineers into the room | `who` — lists current on-call members |
| `@oncall who` — shows who's on rotation | `version` — prints bot version |
| `@oncall Can you look at this?` — relays your message and tags whoever is on-call | `help` — lists commands |
| | `link #channel <schedule>` — connect a channel to a PagerDuty schedule |
| | `unlink #channel` — disconnect a channel |
| | `list` — show all linked channels |

Other bots can mention `@oncall` too. It just works.

### Self-service setup

Anyone can configure the bot for their channel — no config file changes, no redeploy. DM the bot:

```
link #service-team https://company.pagerduty.com/schedules/PXXXXXX
```

The bot saves the link in its local SQLite database, joins the channel, and starts responding to `@oncall` there using that schedule. To remove it:

```
unlink #service-team
```

You can also pass a raw schedule ID instead of a URL (`link #service-team PXXXXXX`).

Channels without an explicit link fall back to the global `schedule_ids` in `config/default.json`, so existing setups keep working.

## Setup

### Prerequisites

- Node.js >= 10 (native SQLite dependency requires it)
- A Slack bot token ([create one here](https://my.slack.com/services/new/bot))
- A PagerDuty API token
- Schedule IDs are optional in config — they can be added per-channel via DM (see above)

### Install

```sh
git clone https://github.com/MadisonReed/oncall-slackbot.git
cd oncall-slackbot
npm install
```

### Configure

Copy the sample config and fill in your credentials:

```sh
cp config/sample.json config/default.json
```

Edit `config/default.json`:

```jsonc
{
  "slack": {
    "slack_token": "xoxb-your-slack-bot-token",
    "bot_name": "OnCall Bot",
    "emoji": ":pagerduty:",
    "emoji_conversation": ":pager: :poop:",
    "welcome_message": "OnCall Bot is alive.  TAG - you're it!",
    "cache_interval_seconds": 3600,
    "next_in_queue_interval": 60,
    "test_user": ""              // optional — route all messages to one user for testing
  },
  "pagerduty": {
    "pagerduty_token": "your-pagerduty-api-token",
    "schedule_ids": ["SCHEDULE_ID_1"],
    "cache_interval_seconds": 300
  }
}
```

> `config/default.json` is gitignored. Your tokens stay local.

### Run

```sh
node oncall_bot.js
```

For debug output:

```sh
DEBUG=oncall_bot node oncall_bot.js    # bot logs
DEBUG=pagerduty node oncall_bot.js     # PagerDuty API logs
DEBUG=db node oncall_bot.js            # database logs
DEBUG=* node oncall_bot.js             # everything
```

For production, use a process manager like [PM2](https://pm2.keymetrics.io/):

```sh
npx pm2 start oncall_bot.js --name oncall-slackbot
```

## Testing

There is no automated test suite yet. To test manually:

1. Set `"test_user"` in your config to your own Slack username.
2. Run the bot and mention `@oncall` in a test channel.
3. All notifications route to you instead of the real rotation.

Adding a proper test framework (Jest, Mocha, etc.) is a welcome contribution — see below.

## Contributing

1. Fork the repo and create a feature branch.
2. Make your changes.
3. Test locally using the `test_user` config flag.
4. Open a pull request with a clear description of what changed and why.

Good first contributions:

- Add a test suite
- Dockerize the bot
- Upgrade to a modern Slack SDK (Bolt)
- Improve error handling and logging

## Project Structure

```
oncall_bot.js        Main entry point — Slack RTM listener and command router
pagerduty.js         PagerDuty API client — fetches current on-call users
db.js                SQLite storage for channel ↔ schedule links
config/sample.json   Configuration template
oncall.db            Auto-created at runtime (gitignored)
```

## License

Built by [Madison Reed](https://www.madison-reed.com/) engineering. Feel free to improve it — we all win.
