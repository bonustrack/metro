# Having Metro issue servers

metro.box can launch a box for you: it holds one AWS key and one Tailscale OAuth
client, runs the EC2 calls itself, and adds the machine to your server list.
Nothing of yours is involved, and no key is ever sent to a browser. This is off until the
deployment is configured. Every box is billed to the AWS account whose key is
configured here.

## What you set on the deployment

Five Fly secrets on the `metro` app. With any of the first three unset or
malformed the whole feature stays off, and the boot log names which ones:
`fly logs` prints `launch: metro issues no servers, these are unset or
malformed`. Without the two Tailscale ones, resizes, disk grows, deletions and
the charts still work, but no new box is launched (`launch: metro issues no new
servers until a Tailscale OAuth client is set`).

| Secret | What it is |
| --- | --- |
| `METRO_AWS_ACCESS_KEY_ID` | An IAM user holding only the policy below. |
| `METRO_AWS_SECRET_ACCESS_KEY` | That user's secret. |
| `METRO_LAUNCH_TAILNET` | The tailnet suffix the boxes join, as in `tail17c4f8.ts.net`. |
| `METRO_TAILSCALE_CLIENT_ID` | A Tailscale OAuth client's id, see The Tailscale key below. |
| `METRO_TAILSCALE_CLIENT_SECRET` | That client's secret, `tskey-client-…`. |

```
fly secrets set -a metro \
  METRO_AWS_ACCESS_KEY_ID=AKIA... \
  METRO_AWS_SECRET_ACCESS_KEY=... \
  METRO_LAUNCH_TAILNET=tail17c4f8.ts.net \
  METRO_TAILSCALE_CLIENT_ID=... \
  METRO_TAILSCALE_CLIENT_SECRET=tskey-client-...
```

`METRO_TAILSCALE_AUTH_KEY`, the one reusable key every box joined with until
2026-10-01, is no longer read. If it is still set, the boot log says so: revoke
that key in the admin console (https://login.tailscale.com/admin/settings/keys)
and `fly secrets unset -a metro METRO_TAILSCALE_AUTH_KEY`. Revoking an auth key
removes no machine: every box that joined with it stays on the tailnet.

### Who may launch

Anyone signed in to metro.box, for their current organization. There is no
allowlist and no cap on how many boxes an organization may have. The one bound on
spend is that one organization cannot run two launches at once: the second one is
refused with a 409.

## The IAM user, step by step

1. Open [Create user](https://console.aws.amazon.com/iam/home#/users/create).
   Name it `metro` and leave **Provide user access to the AWS Management
   Console** unchecked: this identity never signs in anywhere, Fly signs API
   calls with its access key, and a console password would only be a second way
   into the account.
2. On the permissions step choose **Attach policies directly** and attach
   nothing. Next, then Create user.
3. Open the user from the [users list](https://console.aws.amazon.com/iam/home#/users),
   which is where the tabs live: the list page has none. On the **Permissions**
   tab open the **Add permissions** dropdown and choose **Create inline policy**,
   switch to the **JSON** tab, paste the policy below, then name it
   `metro-launch`. Inline rather than managed, so it belongs to this user alone.
4. On the **Security credentials** tab, Access keys, **Create access key**, pick
   **Application running outside AWS**. Copy both halves at once: AWS shows the
   secret only at creation, and a user may hold at most two keys.

These actions are all a launch, its progress view, a resize, a disk grow, a
delete and the Usage charts use.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ec2:DescribeRegions",
        "ec2:DescribeAvailabilityZones",
        "ec2:DescribeImages",
        "ec2:DescribeInstances",
        "ec2:DescribeVolumes",
        "ec2:DescribeVolumesModifications",
        "ec2:RunInstances",
        "ec2:CreateTags",
        "ec2:GetConsoleOutput",
        "ec2:DescribeInstanceTypes",
        "pricing:GetProducts",
        "cloudwatch:GetMetricData",
        "cloudwatch:ListMetrics"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "ec2:StopInstances",
        "ec2:StartInstances",
        "ec2:ModifyInstanceAttribute",
        "ec2:TerminateInstances",
        "ec2:AssociateIamInstanceProfile",
        "ec2:ModifyVolume",
        "ec2:RebootInstances"
      ],
      "Resource": "*",
      "Condition": { "Null": { "aws:ResourceTag/metro": "false" } }
    },
    {
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": "arn:aws:iam::*:role/metro-box",
      "Condition": { "StringEquals": { "iam:PassedToService": "ec2.amazonaws.com" } }
    }
  ]
}
```

The second statement is only for a resize, a disk grow and a delete, and only
on instances and disks with a `metro` tag, which every box Metro launches
carries. That guards against a mistake, not against a stolen key: the first
statement allows `CreateTags` anywhere, so the key could tag something else
first. Disks launched before 2026-09-29 have no `metro` tag; Metro writes the
box's own tag on its disk (`CreateTags`) just before it grows it the first
time, and retries `ModifyVolume` for up to 30 seconds while AWS spreads the new
tag to IAM. It holds no `DeleteVolume`:
a box's disk goes with it through `DeleteOnTermination`. Before 2026-09-29 the
policy had neither `DescribeVolumes` nor `TerminateInstances`, and the Delete
dialog then names the missing one. `DescribeInstanceTypes` lists the sizes,
and `pricing:GetProducts` only shows the price next to each size: without it
the sizes show no price. The last statement and the `cloudwatch` actions are
for the Usage charts, below: `iam:PassRole` lets a launch and
`AssociateIamInstanceProfile` give a box the `metro-box` role and no other. A
policy copied on 2026-09-29 may also hold `sts:AssumeRole` on
`role/metro-cloudwatch-read`, for the charts of a box in another AWS account.
Metro no longer reads those, so that statement can go.

## The Tailscale key

Every launch gets its own auth key (`apps/api/src/aws/tailscale-key.ts`): the
api trades the OAuth client for a short-lived token, and asks Tailscale for one
key that is single use, preauthorized, tagged `tag:metro-box` and expires after
one hour. Only that key goes into the instance's user data, so a box can read
nothing but a key that is already spent (or dead within the hour), and no key
in user data can join a second machine. If Tailscale refuses, no instance
starts and the page shows Tailscale's own words.

The box joins as a tagged device, so it belongs to the tag, not to a person,
and its node key does not expire. The policy file
(https://login.tailscale.com/admin/acls/file) needs three entries for the tag:

```
"tagOwners": { "tag:metro-box": ["autogroup:admin"] },
"nodeAttrs": [ { "target": ["tag:metro-box"], "attr": ["funnel"] } ],
"ssh": [ { "action": "check", "src": ["autogroup:admin"], "dst": ["tag:metro-box"], "users": ["autogroup:nonroot", "root"] } ]
```

Without the `funnel` attribute a box cannot open its public address, and
without the SSH rule nobody can reach it as root over Tailscale SSH. Then the
client, under Settings, OAuth clients
(https://login.tailscale.com/admin/settings/oauth): Generate OAuth client,
scope Keys, Auth Keys, Write, tag `tag:metro-box`, and nothing else. The secret
is shown once. A client holding only that scope can make join keys for that tag
and nothing more: it cannot list, change or remove machines.

## The instance metadata service

Anything on an EC2 instance can ask `169.254.169.254` for the instance's user
data (the first-boot script, with its Tailscale key) and for its role's
credentials. The agent has no use for either, so the agent may not ask:

- **Launch:** IMDSv2 only (`HttpTokens=required`) with a hop limit of 1
  (`HttpPutResponseHopLimit=1`), so a container on the box cannot get a token.
- **Box:** the root helper's `imds-block` (helper version 2) sends all traffic
  to `169.254.169.254` and `fd00:ec2::254` from any user except root and
  `metro` into an iptables and ip6tables chain, `METRO_IMDS`, that rejects it.
  The unit `metro-imds.service` runs it at every boot before the network comes
  up, and the daemon runs it again at every start. Root (cloud-init, the SSM
  agent) and `metro` (the CloudWatch readings, below) still reach it. A
  DigitalOcean droplet answers on the same address with its own user data, and
  gets the same wall.
- **Boxes installed before helper version 2** keep an older helper, which
  `metro` cannot replace. The daemon logs `imds: the agent can still read the
  instance metadata` at every start until the one root run of the next
  section is done.

## The root side follows updates

Root work on a box goes through one helper, `/usr/local/lib/metro/root-helper`,
that `metro` may run with sudo. Until helper version 3 a new helper needed a
root shell on every box. Now the root side upgrades itself when the box
updates, and the `metro` user still cannot run any code of its choice as root
(Less, 2026-10-01, #112).

- **What metro can do:** run the helper's `upgrade <version>`. The helper
  takes only a plain version (`1.2.3` or `1.2.3-beta.4`) and starts
  `metro-root-upgrade@<version>.service` without waiting. That is all metro
  passes: no file, no path, no package.
- **What root does:** the unit (oneshot, one at a time under `flock`) runs
  `node /usr/local/lib/metro/release/dist/cli.js service root-upgrade <version>`
  from root's own copy of Metro. It refuses unless all of these hold:
  1. the version is newer than root's copy (never the same, never older);
  2. it is what the `beta` or `latest` tag of `@stage-labs/metro` points to now;
  3. the tarball is `https://registry.npmjs.org/@stage-labs/metro/-/metro-<version>.tgz`
     and matches the sha512 npm publishes for it;
  4. npm holds a SLSA provenance for it whose Sigstore signature checks out,
     signed by GitHub Actions for
     `https://github.com/bonustrack/metro/.github/workflows/publish-cli.yml@refs/heads/main`,
     and whose statement names this package, this version and this tarball's
     sha512. The check uses the `sigstore` library that ships inside npm, next
     to root's `node`, and only when every folder up to it belongs to root.

  Then it unpacks the tarball into `/usr/local/lib/metro/release.new` (root,
  0755) and runs that copy's `metro-user/install.ts` with root's own Bun
  (`--no-install`, a clean environment, from `/`). That writes the helper, the
  sudo rules, `metro-imds.service` and the upgrade unit. Only then does
  `release.new` replace `release`. A failure keeps the old copy and says why
  in the journal: `journalctl -u 'metro-root-upgrade@*'`.
- **Why metro cannot get root from it:** root never reads a file metro wrote
  and never runs code from a path metro can write. The copy, the units, node,
  npm and Bun are root's. A version string is all metro controls, and the most
  it can do is ask early for the newest signed release. A stolen npm token is
  not enough either: a package published outside the repo's publish workflow
  on `main` has no matching provenance (old versions published by
  `publish.yml` are refused the same way). The check rests on the Sigstore
  signature, not only on TLS, so a certificate metro added to the system store
  (the vault's `trust-ca`) changes nothing.
- **When it runs:** the daemon asks at every start (`followRelease` in
  `metro-user/root-follow.ts`), so after every Update, and again at the next
  start after a failed try.
- **A new box** gets all of it from cloud-init: `metro service install --user
  metro` does the same checked install of its own version before it writes the
  service (root chose that version, so the tag rule does not apply there).
- **A box whose helper is older needs one root run, then never again:**

  ```
  ssh root@<box> npx -y @stage-labs/metro@<version> service install --user metro
  ```

  `npx` as root fetches its own copy, so no file metro can write runs as root
  even then. The daemon logs this command, with its version, at every start
  until it is done. Run on a box that already has it, the command only runs
  root's setup again; it never installs an older copy.
- **The drop-in writer** (version 3): `dropin-write` takes only
  `11-metro-vault.conf` with exactly `[Service]` and
  `EnvironmentFile=-<agent home>/.metro/vault.env`, and only on a timer job
  that runs as the agent with no command run with root rights (`+`, `!`, `!!`
  or `PermissionsStartOnly`, read from systemd's `Exec*Ex` properties; a
  systemd too old to show them is refused). Before, metro could add
  `ExecStart=` or `Environment=` lines to a timer job that runs as root, or
  hide `User=agent` behind a line continuation, and get root that way.
  `10-metro-agent.conf` is gone, and a service name must start with a letter
  or digit, so it can never read as a `systemctl` flag.

## Two AWS account traps

**"The specified instance type is not eligible for Free Tier."** The account is on
the AWS Free plan, which only permits free-tier-eligible instance types, and the
`t4g.medium` a metro box runs on is not one. Sign in to the AWS console, choose
**Upgrade plan**, then **Upgrade account**. Credits you have not spent stay usable.

**A vCPU limit of 1.** New accounts often carry a running On-Demand vCPU quota of
1, and `t4g.medium` needs 2, so a launch can still be refused right after the plan
upgrade. Raise it from Service Quotas, "Running On-Demand Standard instances" for
the region you launch in.

## What a launch does

The browser sends a name and a region, both required. The region is chosen in
the form, so the deployment configures none. The owner is not sent: it is the
organization in the sign-in token of the person who asks.

The server picks the newest Ubuntu 24.04
arm64 image, runs one `t4g.medium` with an 8 GiB gp3 root, and retries every
availability zone in the region when AWS answers `InsufficientInstanceCapacity`,
which is what a region running short of that instance type looks like. The
machine joins the tailnet under a random `metro-xxxxxx` name that cannot clash
with another box, installs Node, bun, Claude Code, Tailscale and Metro on first
boot, and runs `metro service install --owner <the organization that asked>`, so the
box belongs to that organization and not to the deployment. Only members of that
organization can sign in to it.

Two launches at once from one organization are refused with a 409 rather than starting
two instances, and the row is written to your agent list only once EC2 has
answered with an instance id.

## Usage charts (CloudWatch)

The Server page's Usage section reads AWS CloudWatch through api.metro.box, so
the charts keep working while a box is down and show gaps where there is no
data. CPU, CPU credits (burstable sizes only) and the status checks come from
EC2's own metrics (`AWS/EC2`, every 5 minutes, free). Memory and disk come from
the box: from beta.224 the Metro daemon sends `mem_used_percent` and
`disk_used_percent` of `/` once a minute to the `CWAgent` namespace, the names
the CloudWatch agent uses, so a box that runs the official agent instead shows
the same charts. The daemon runs as the `metro` user and cannot install a
package, which is why it sends the two readings itself. It signs with the
instance's role, read from the instance metadata. With no role, or off EC2, it
sends nothing and logs it once. Only a box Metro launched in its own AWS account
has charts. Any other box (in another AWS account, added by its address, or
hosted elsewhere, such as on DigitalOcean) has none yet, and the page says so.

Restarts show as dashed lines across every chart: red when the server
restarted, grey when only Metro did. From beta.225, when the daemon starts it
adds one more reading to its first send: `server_booted` if the server has been
up for less than 5 minutes (a reboot, a stop and start, a resize), else
`metro_started` (an Update, a Restart, a crash). The value is the time of the
start in seconds since 1970, so the api places the line to the second in every
range. It goes out once per start, in the same write, under the same role, so
it needs no new permission and costs almost nothing. A restart of the Claude
session alone is not a restart here.

Two custom metrics and one write a minute cost roughly $1 a month per box at
CloudWatch's list prices, less inside its free tier. An open Usage section
reads seven metrics a minute.

**The `metro-box` role**, once in Metro's AWS account, for the instances:

1. [Create role](https://console.aws.amazon.com/iam/home#/roles/create):
   trusted entity **AWS service**, use case **EC2**, Next. Attach nothing, Next.
   Name it `metro-box`, then Create role. The console also makes the instance
   profile of the same name.
2. Open the role, **Add permissions**, **Create inline policy**, JSON, paste
   this, and name it `metro-box-metrics`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "cloudwatch:PutMetricData",
      "Resource": "*",
      "Condition": { "StringEquals": { "cloudwatch:namespace": "CWAgent" } }
    }
  ]
}
```

A launch gives the new instance this role. If the role does not exist yet, or
the key may not pass it, the server starts without it and the api logs it. A box
Metro launched gets the role the first time its Usage section finds no memory
reading (`AssociateIamInstanceProfile`, only on an instance whose `metro` tag is
the box's node). Any other instance gets it in the EC2 console: select it,
Actions, Security, Modify IAM role, `metro-box`, Update IAM role. The daemon
then sends within a minute, once the box runs beta.224 or later.

The role is readable through the instance metadata by root and `metro` only
(see The instance metadata service; on a box whose helper predates version 2,
by anything on it, the agent included). It can only write metrics into
`CWAgent`, but under any name and any instance id: whoever holds it could write
false memory or disk readings for another box in the same account, or add
custom metrics that AWS bills (about $0.30 each a month). The charts are for reading only, so nothing
acts on them. The CloudWatch agent's own `CloudWatchAgentServerPolicy` reaches
further than this.

## Deleting a box

The Server page of a box Metro launched has a Delete button, for an admin of
the organization. The dialog reads AWS first and lists exactly what goes: the
instance id and type, and each disk attached to it with its id and size. It
asks for the agent's name to be typed, and sends those ids back with it.

The api then checks everything again and refuses at the first thing that does
not match, before any change:

- the row is found by its id inside the signed-in organization only, and its
  stored instance id is the only one ever asked for;
- the instance's `metro` tag must be the node of the row's address, and its
  `metro:agent` tag, when present, must be this row's id (boxes launched
  before 2026-09-29 have only `metro` and `Name`). The organization is not
  tagged, since Move to another organization changes it: the row's id, found
  only inside the signed-in organization, is what binds the two;
- each disk is asked for by its exact id, must be attached to this instance
  alone, and must not be tagged for another box;
- the ids, and the state of the instance, must be the ones the dialog showed.

A disk not set to go with its server is set to by its device, and checked
again. Then `TerminateInstances` runs with that one id, AWS deletes the disk
with the instance, and the row leaves the list. Nothing is listed or filtered
at any step, and no disk is deleted by id.

A box that is no longer on AWS only leaves the list. That is a box AWS reports
terminated, or one AWS does not know at all (`InvalidInstanceID.NotFound`). The
dialog says "Server not found on AWS, only the agent entry will be removed",
the name is still typed, and nothing is written to AWS. The confirm asks AWS
again and refuses if the instance came back or its state changed. Some cases
are still refused, and the row stays:

- AWS does not know the box and its row is less than 10 minutes old. EC2
  answers NotFound for a few seconds after a launch. Try again later.
- AWS is still shutting the box down. Try again in a few minutes.
- AWS answers with any other error: the key is refused, the call is
  throttled, or EC2 cannot be reached.

AWS also answers NotFound when the key belongs to another AWS account, so the
dialog names the instance id and its region.

The Tailscale machine stays in the tailnet, offline, since Metro's OAuth client
may only make join keys. Remove it in the admin console under Machines. No DNS record exists for a box, so there is none to remove.

The Metro operator (the `admin@stage.box` account, not an organization's
admin) can also delete a box of any organization from Admin, Agents. The same
dialog names the organization the box belongs to. The api finds the row by its
id in every organization, then runs exactly the same checks, and logs who
deleted which box for which organization. An agent Metro did not launch also
has Delete there. It only removes the agent entry, and its machine keeps
running.

## Growing the disk of a box

The Server page of a box Metro launched has a Storage section: the root disk's
size, its type and the AWS price per month. An admin of the organization picks
a bigger size (16 to 2048 GB, up to what AWS allows for the disk type, 64 TiB
for gp3) and types `grow` to confirm. The dialog says the change cannot be
undone: AWS never shrinks a disk.

The api reads the instance and its root disk by their exact ids and checks
them like a delete (the instance's `metro` tag is the box's node, the disk is
attached to it alone and not tagged for another box), then calls
`ModifyVolume` with the new size. It follows `DescribeVolumesModifications`
until AWS reports `optimizing` or `completed`, which is when the new size is
usable (usually seconds), then `RebootInstances` once. At boot, cloud-init's
`growpart` and `resizefs` grow the partition and the file system to the whole
disk, so the box comes back with the space after about a minute. Metro itself
cannot grow the file system without a restart: it has no root. A stopped box is not
started: it uses the space when it starts.

AWS takes the next change to a disk only once the last one is `completed`
(the optimization can take hours on a big disk), and at most four in 24 hours.
The page says when the last change is still being applied, and an AWS refusal
is shown as AWS words it. A grow and a resize of the same box never run at
once, and a delete waits for both. The job lives in the api's memory, like a
resize: a deploy in the middle stops following it, and the box then uses the
space after its next restart.

## Changing the size of a box

The Server page of a box Metro launched shows its size (vCPUs, memory, the AWS
price) and, for an admin of the organization, the other sizes of the same kind
of processor: `t4g` and `m7g` on ARM, `t3` and `m7i` on x86, from 4 GB up,
only those AWS offers in the box's region. A resize stops the instance, changes
its type and starts it again, so the agent is offline for one to two minutes
and its Claude session restarts. The disk, the Tailscale name and the Funnel
address stay. The public IP changes, which nothing uses.

If AWS refuses the new size (no capacity in the zone, the account's vCPU quota,
a type the instance cannot take), metro puts the old type back and starts the
box again, and the page says why. If even that fails, the page says the box is
stopped and offers Start. The job lives in the api's memory, so a deploy in
the middle of one stops it. The page still reads the instance's real state
from AWS, and a stopped box shows Start.

A box Metro did not launch (added by its address, or hosted elsewhere, such as
on DigitalOcean) has no instance in this account, and the page says so.
