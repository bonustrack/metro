# Having Metro issue servers

metro.box can launch a box for you: it holds one AWS key and one Tailscale auth
key, runs the EC2 calls itself, and adds the machine to your server list. Nothing
of yours is involved, and no key is ever sent to a browser. This is off until the
deployment is configured. Every box is billed to the AWS account whose key is
configured here.

## What you set on the deployment

Four Fly secrets on the `metro` app. With any of them unset or malformed the
feature stays off, and the boot log names which ones: `fly logs` prints
`launch: metro issues no servers, these are unset or malformed`.

| Secret | What it is |
| --- | --- |
| `METRO_AWS_ACCESS_KEY_ID` | An IAM user holding only the policy below. |
| `METRO_AWS_SECRET_ACCESS_KEY` | That user's secret. |
| `METRO_LAUNCH_TAILNET` | The tailnet suffix the boxes join, as in `tail17c4f8.ts.net`. |
| `METRO_TAILSCALE_AUTH_KEY` | A **reusable** auth key, `tskey-auth-…`. |

```
fly secrets set -a metro \
  METRO_AWS_ACCESS_KEY_ID=AKIA... \
  METRO_AWS_SECRET_ACCESS_KEY=... \
  METRO_LAUNCH_TAILNET=tail17c4f8.ts.net \
  METRO_TAILSCALE_AUTH_KEY=tskey-auth-...
```

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

These seven actions are all a launch and its progress view use.

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
        "ec2:RunInstances",
        "ec2:CreateTags",
        "ec2:GetConsoleOutput"
      ],
      "Resource": "*"
    }
  ]
}
```

It cannot stop or terminate anything, so cleaning up a box is still a job for the
AWS console.

## The Tailscale key

A reusable auth key from the admin console under Settings, Keys. It has to be
reusable, since every box joins with the same one.

Worth knowing what that means: the key is written into each instance's user data,
which anything with root on that box can read, and it does not expire on use. So
one compromised box can join further machines to your tailnet until you rotate
the secret. Metro never returns the key over any route and redacts every
`tskey-…` out of the boot log it serves, but it cannot keep it away from the box
that has to use it. Rotating is one `fly secrets set` plus revoking the old key.

The safer shape, if you want it later, is an API access token or an OAuth client
and a fresh single-use key minted per launch. That is one module, `authKey` in
`apps/api/src/launch-config.ts`, and an OAuth client additionally needs a
`tagOwners` entry, the `funnel` node attribute and an SSH rule for the tag.

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
