---
title: Integrations
sidebar:
  order: 13
---

## Push webhook

With `webhookSecretFile` (`X_NIX_WEBHOOK_SECRET_FILE`) set, `POST /api/webhook` takes push deliveries from a forge.
A push:

- evaluates at once every deployment whose flake follows the pushed repository and branch, instead of waiting for
  `eval_interval`;
- reads every such flake again;
- updates at once every flake with a watched input following the pushed branch, so a webhook on an input's own
  repository skips even the input check's wait.

A `github:`, `gitlab:` or `sourcehut:` flake, or a `git+https://` or `git+ssh://` one, follows its repository. A flake
naming no branch follows the default branch, and a pinned one follows nothing. Pushes to one deployment within
`webhookDebounce` start one evaluation, and an address sending ten unsigned deliveries is turned away for five minutes.

- **GitHub**: Settings → Webhooks → Add webhook, payload URL `https://nix.example.org/api/webhook`, content type
  `application/json`, the secret file's contents as the secret, just the push event.
- **Forgejo or Gitea**: Settings → Webhooks → Add webhook → Forgejo (or Gitea), the same URL, `POST` with
  `application/json`, the secret as the secret, push events. Forgejo's "Authorization header" may instead hold
  `Bearer <secret>`.
- **GitLab**: the secret goes in the secret token, which GitLab sends as `X-Gitlab-Token`.

## Notifications

X-Nix sends a notification when a job runs [overdue](/user/jobs-and-builds/#overdue-jobs), to every channel in the
config's `notifications` list:

```json
"notifications": [{ "type": "ntfy", "topic": "x-nix", "token_file": "/var/lib/x-nix/ntfy-token" }]
```

| Type      | Settings                                                                                       |
|-----------|------------------------------------------------------------------------------------------------|
| `ntfy`    | `topic` or `topic_file`, `url` (default `https://ntfy.sh`), `token` or `token_file`, or `username` with `password` or `password_file`, `priority` (1-5 or a name; by default by the notification's level), `tags`. |
| `webhook` | `url` or `url_file`, `method`, `headers`, `bearer_token` or `bearer_token_file`, and a `payload` template whose `{title}`, `{body}` and `{level}` are filled in; JSON of those three by default. |
| `mail`    | `host`, `security` (`starttls`, `tls` or `none`; default `starttls`), `port` (by default the security's), `username` with `password` or `password_file`, `from` (default the username), `to` (one address or a list), `subject_prefix`; the title is the subject and the body the text. |
| `apprise` | `urls`, or `urls_file` with one per line; needs the `apprise` program on the service's PATH (add it with `path`). |

Prefer the `_file` form of each secret, so the secret stays out of the config.

## Monitoring X-Nix

`GET /api/health` answers without a sign-in with the server's name, version and start time, for any HTTP check such as
X-Monitor's.

## Backups

X-Nix's database holds the users added on the Users page, their sessions and tokens, and every job, event, build and
reading. It is backed up once a day into `<state dir>/backups`, keeping the last 14 daily copies. Under **Backups** on
the Settings page, an admin changes that schedule, backs up by hand, restores, or deletes a backup.

![Backups on the Settings page](/assets/screenshots/backups.png)

A restore first backs up the current data, then restarts the server, which comes back with the backup in place of the
database.

Your flakes, hosts, deployments and caches come from the config file, not the database, so keep the config in your
flake as you would any other.
