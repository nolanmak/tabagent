# Field notes: tabs that think

By [Ada L.](http://news.test/authors/ada)

Browser agents read pages through an *accessibility tree*, not pixels. That makes them **fast** and cheap.

## Why refs matter

Every interactive node gets a short ref such as `e12`. The agent acts on refs instead of CSS selectors.

1. Snapshot the page
2. Pick a ref
3. Act on it

> Refs are cheap; selectors are brittle.

## Numbers

| Tool | Tokens |
| --- | --- |
| snapshot | 1200 |
| markdown | 800 |

```
tabagent page.markdown --json '{}'
```

Read the [design notes](http://news.test/docs/design) for more.
