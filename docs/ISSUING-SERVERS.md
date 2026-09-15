# Having Metro issue servers

metro.box can launch a box for you: it holds one AWS key and one Tailscale auth
key, runs the EC2 calls itself, and adds the machine to your server list. Nothing
of yours is involved, and no key is ever sent to a browser. This is off until the
deployment is configured, and even then only the wallets named below may ask for
one, because every box is billed to the AWS account whose key is configured here.

## What you set on the deployment

Five Fly secrets on the `metro` app. With any of them unset or malformed the
feature stays off, and the boot log names which ones: `fly logs` prints
`launch: metro issues no servers, these are unset or malformed`.

| Secret | What it is |
| --- | --- |
| `METRO_AWS_ACCESS_KEY_ID` | An IAM user holding only the policy below. |
| `METRO_AWS_SECRET_ACCESS_KEY` | That user's secret. |
| `METRO_LAUNCH_TAILNET` | The tailnet suffix the boxes join, as in `tail17c4f8.ts.net`. |
| `METRO_TAILSCALE_AUTH_KEY` | A **reusable** auth key, `tskey-auth-…`. |
| `METRO_LAUNCH_OWNERS` | Comma-separated wallet addresses allowed to launch. |

`METRO_LAUNCH_MAX` is optional and caps how many servers one wallet may have
Metro issue, 10 by default and 100 at most. Removing a server from your list
frees a slot, so the cap bounds what one wallet can run up, not what it can ever
launch.

```
fly secrets set -a metro \
  METRO_AWS_ACCESS_KEY_ID=AKIA... \
  METRO_AWS_SECRET_ACCESS_KEY=... \
  METRO_LAUNCH_TAILNET=tail17c4f8.ts.net \
  METRO_TAILSCALE_AUTH_KEY=tskey-auth-... \
  METRO_LAUNCH_OWNERS=0xef8305e140ac520225daf050e2f71d5fbcc543e7
```

## The IAM user

Create a user with no console access and this inline policy, nothing else. These
seven actions are all a launch and its progress view use.

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

## What a launch does

The browser sends a name and a region, both required: the region is chosen in the
form from the regions the account has enabled, so the deployment configures none.
The server picks the newest Ubuntu 24.04
arm64 image, runs one `t4g.medium` with an 8 GiB gp3 root, and retries every
availability zone in the region when AWS answers `InsufficientInstanceCapacity`,
which is what a region running short of that instance type looks like. The
machine joins the tailnet under a random `metro-xxxxxx` name that cannot clash
with another box, installs Node, bun, Claude Code, Tailscale and Metro on first
boot, and runs `metro service install --owner <the wallet that asked>`, so the
box belongs to that wallet and not to the deployment.

Two launches at once from one wallet are refused with a 409 rather than starting
two instances, and the row is written to your server list only once EC2 has
answered with an instance id.
