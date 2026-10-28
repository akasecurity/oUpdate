# Security policy

oUpdate decides whether a dependency update is safe to land, so a way to make it approve a malicious update, or to skip part of what it should review, is a vulnerability. Please report it privately.

## Supported versions

Fixes go into the latest release. Install a release tag (see the README) and update to the newest one when a fix ships.

| Version | Supported |
| --- | --- |
| latest 0.2.x release | yes |
| older releases | no |

## Reporting a vulnerability

Use GitHub's private reporting: open the repository's **Security** tab and choose **Report a vulnerability**. Please don't open a public issue, pull request or discussion for it.

A useful report has:
- the oUpdate version or commit;
- the command and flags you ran (`review`, `gate`, `host`, `image`);
- the inputs: package names and versions, or a minimal package or lockfile that shows the problem;
- what oUpdate did and what it should have done.

## What happens next

1. We acknowledge the report in the advisory thread.
2. We confirm it and work on a fix privately in that advisory.
3. The fix ships in a release, and the advisory is published with it. It credits you unless you ask us not to.

If a report turns out not to be a vulnerability, we say why in the thread. If it is an ordinary bug, we may ask you to open a public issue.
