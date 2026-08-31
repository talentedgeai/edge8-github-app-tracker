
## Pull request bodies — session trailer

This repo's commits carry `Claude-Session:` and `Claude-Session-Start:` trailers (stamped automatically by a git hook). When opening a pull request, copy the two trailer lines from this branch's commits (see `git log`) to the end of the PR body, exactly as they appear:

```
Claude-Session: <uuid from the commit trailer>
Claude-Session-Start: <timestamp from the commit trailer>
```

The human-token tracker reads them to pair the PR with its session. If the branch's commits carry no such trailers, omit the lines — never invent values.
