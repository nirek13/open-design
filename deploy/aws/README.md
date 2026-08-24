# Open Design AWS Deployment

CloudFormation + ECS/Fargate runbook for hosting Open Design on AWS.

| File | Purpose |
| --- | --- |
| [`template.yaml`](./template.yaml) | Stack: VPC, ALB, ECS, EFS, Secrets Manager, optional HTTPS |
| [`set-mode.sh`](./set-mode.sh) | Flip **economy** (cheap) ↔ **performance** (VC demo) without rebuilding |
| [`redeploy-local.sh`](./redeploy-local.sh) | Build local checkout → ECR → roll ECS (keeps runtime fixes) |

For Docker Compose / GHCR images, see [`../README.md`](../README.md). For Azure, see [`../azure/README.md`](../azure/README.md).

---

## Architecture

```
Internet (allowlisted CIDR only)
        │
        ▼
   ALB (HTTP :80, optional HTTPS :443)
        │
        ▼
   ECS Fargate task (public subnet + public IP; inbound only from the ALB SG)
   ┌─────────────────────────────────────┐
   │  auth-proxy (nginx)  →  app (daemon)│
   │  injects Bearer token for /api/*    │
   │  rewrites Host/Origin to loopback   │
   └─────────────────────────────────────┘
        │
        ▼
   EFS (persistent .od data) — DeletionPolicy: Retain
```

- **DesiredCount: 0 or 1** — SQLite under EFS must not be multi-writer. `0` parks the task.
- **No NAT gateways** — Fargate uses a public IP for outbound (ECR, AWS APIs, model providers). Inbound is still only the ALB security group. This drops ~\$65/mo versus dual NAT.
- **Auth model:** browser hits ALB; nginx adds `Authorization: Bearer <ApiToken>` for `/api/`. Token lives in Secrets Manager, not in the image.

### Cost modes (economy vs performance)

Stay on **economy** day-to-day. Flip to **performance** about 10 minutes before a VC demo, then flip back.

| Mode | Fargate | ALB idle timeout | Logs | Ballpark 24/7 (us-east-1) |
| --- | --- | --- | --- | --- |
| `economy` (default) | 0.25 vCPU / 1 GB (`small`; `TaskSize` still applies) | 10 min | 3 days | **~$25–35/mo** (ALB + small Fargate + EFS) |
| `performance` | 4 vCPU / 16 GB | ~66 min | 14 days | **~$175–200/mo** if left on |
| `stop` | desired count 0 | — | kept | **~$16–20/mo** (ALB + EFS; data retained) |

NAT used to be ~\$32/mo **each** (two of them). They are gone in both modes — they did not make the app faster.

```bash
./deploy/aws/set-mode.sh economy        # cheap default
./deploy/aws/set-mode.sh performance    # before a demo
./deploy/aws/set-mode.sh economy        # after the demo
./deploy/aws/set-mode.sh stop           # park overnight / weekend
./deploy/aws/set-mode.sh status
```

The first stack **update** after this template change deletes the NAT gateways (several minutes) and moves the task onto public subnets. Later mode switches only replace the task definition (a few minutes). `set-mode.sh` reuses the image the service is already running so a mode flip does not roll you back to an old GHCR tag.

Daemon data paths follow root [`AGENTS.md`](../../AGENTS.md) → **Daemon data directory contract**. Do not invent alternate data roots in this doc.

---

## Prerequisites

- AWS account + CLI configured (`aws sts get-caller-identity`)
- Docker (builds must be `linux/amd64` for default `TaskCpuArchitecture=X86_64`)
- Optional for HTTPS later: a domain you control + ACM in the **same region as the ALB**
- Optional for watch redeploys: `brew install fswatch`

### First-time KMS note

Some accounts lack `alias/aws/efs`. If stack create fails on EFS encryption, create a CMK (e.g. `alias/open-design-efs`) and wire it in the template / console before retrying.

---

## Parameters

| Parameter | Required | Notes |
| --- | --- | --- |
| `AllowedSourceIp` | Yes | CIDR `/16`–`/32` allowlisted to the ALB (home/VPN IP, not `0.0.0.0/0`) |
| `ApiToken` | Yes | Long random secret; stored in Secrets Manager |
| `DockerImage` | Yes | Full URI+tag (ECR or GHCR). Initial seed only — local rolls use `redeploy-local.sh` |
| `CustomDomainName` | No | e.g. `od.example.com`. Blank = HTTP on ALB DNS only |
| `AcmCertificateArn` | If domain | ACM cert ARN in the ALB region |
| `TaskSize` | No | `small` / `medium` / `large` / `xlarge`. Used in **economy** only |
| `OperatingMode` | No | `economy` (default) or `performance`. Use `set-mode.sh` |
| `DesiredCount` | No | `0` or `1`. `0` parks the task (ALB still bills) |
| `TaskCpuArchitecture` | No | Must match image (`X86_64` ↔ `linux/amd64`) |
| `ProxyPort` | No | Nginx listen port (≥1024), default `8080` |
| `AppStoragePath` | No | EFS mount in container; see daemon data contract |

---

## Initial stack deploy

### Console

1. CloudFormation → Create stack → Upload `template.yaml`
2. Stack name e.g. `open-design-stack`
3. Set `ApiToken`, `AllowedSourceIp`, `DockerImage`
4. Acknowledge IAM capabilities → Submit
5. Outputs: `AppUrl`, `AlbDnsName`

### CLI

```bash
# Generate a token once; store it somewhere safe (password manager).
openssl rand -hex 32

aws cloudformation deploy \
  --template-file deploy/aws/template.yaml \
  --stack-name open-design-stack \
  --capabilities CAPABILITY_IAM \
  --region us-east-1 \
  --parameter-overrides \
    ApiToken="PASTE_TOKEN_HERE" \
    AllowedSourceIp="YOUR.PUBLIC.IP/32" \
    DockerImage="ghcr.io/nexu-io/od:latest"
```

After create, prefer pushing **your** image (next section) rather than leaving mutable `latest` from GHCR.

### Useful defaults for this repo’s reference deployment

| Setting | Typical value |
| --- | --- |
| Stack | `open-design-stack` |
| Region | `us-east-1` |
| ECR repo | `open-design` (created by `redeploy-local.sh` if missing) |
| Task family | `opendesign-app` |
| Health | `GET /api/health` |

---

## Redeploy from local source (day-to-day)

The CloudFormation `DockerImage` parameter is only the **initial** image. Day-to-day updates:

```bash
# From repo root
./deploy/aws/redeploy-local.sh

# Auto rebuild when apps/, packages/, or deploy/ change
brew install fswatch   # once
./deploy/aws/redeploy-local.sh --watch
```

What the script does:

1. `docker build --platform linux/amd64 -f deploy/Dockerfile`
2. Tag `ACCOUNT.dkr.ecr.REGION.amazonaws.com/open-design:local-<gitsha>-<utc>`
3. Push to ECR
4. Register a new ECS task definition that **preserves**:
   - Auth-proxy Host/Origin rewrite to `127.0.0.1:${OD_WEB_PORT}` (required behind ALB)
   - `OD_ALLOWED_ORIGINS` = lowercase ALB origin, or `https://<CustomDomain>` if stack AppUrl is HTTPS
   - No AMR/Vela bootstrap on container start
5. Force new deployment and wait for service stability
6. Curl `/api/health`

Overrides:

```bash
STACK=open-design-stack REGION=us-east-1 ECR_REPO=open-design ./deploy/aws/redeploy-local.sh
```

**zsh tip:** always quote ECR tags as `"${ECR}:tag"`. Unquoted `$ECR:tag` treats `:t` as a zsh modifier.

Expect several minutes per rebuild (image build + push + ECS roll).

---

## Make it secure (HTTPS) when you have a domain

Browsers **cannot** show a padlock for `*.elb.amazonaws.com`. You need your own hostname.

### Checklist

1. [ ] Domain you control (e.g. `od.example.com`)
2. [ ] ACM certificate in **ALB region** (for `us-east-1` stacks, cert must be in `us-east-1`)
3. [ ] DNS validation completed → cert **ISSUED**
4. [ ] Stack updated with `CustomDomainName` + `AcmCertificateArn`
5. [ ] DNS CNAME or Alias → stack output `AlbDnsName`
6. [ ] `./deploy/aws/redeploy-local.sh` once so `OD_ALLOWED_ORIGINS` becomes `https://od.example.com`
7. [ ] Open `https://od.example.com`, confirm padlock + `/api/health`

### Request and validate a certificate

```bash
REGION=us-east-1
DOMAIN=od.example.com

aws acm request-certificate \
  --region "$REGION" \
  --domain-name "$DOMAIN" \
  --validation-method DNS \
  --query CertificateArn --output text
# → arn:aws:acm:us-east-1:ACCOUNT:certificate/UUID

# Show DNS records you must create at your DNS provider:
aws acm describe-certificate \
  --region "$REGION" \
  --certificate-arn "ARN_FROM_ABOVE" \
  --query 'Certificate.DomainValidationOptions[0].ResourceRecord'
```

Add the CNAME ACM returns. Wait until:

```bash
aws acm describe-certificate --region "$REGION" --certificate-arn "ARN" \
  --query 'Certificate.Status' --output text
# ISSUED
```

### Update the stack for HTTPS

Template behavior when `CustomDomainName` is set:

- Listener **:443 HTTPS** terminates TLS with your ACM cert
- Listener **:80** redirects to HTTPS
- `OD_ALLOWED_ORIGINS` in the template becomes `https://${CustomDomainName}`

```bash
# Use your current ApiToken / AllowedSourceIp / latest ECR image tag.
# CloudFormation deploy needs all required params you care about preserved.

aws cloudformation deploy \
  --template-file deploy/aws/template.yaml \
  --stack-name open-design-stack \
  --capabilities CAPABILITY_IAM \
  --region us-east-1 \
  --parameter-overrides \
    CustomDomainName="od.example.com" \
    AcmCertificateArn="arn:aws:acm:us-east-1:ACCOUNT:certificate/UUID" \
    DockerImage="ACCOUNT.dkr.ecr.us-east-1.amazonaws.com/open-design:YOUR_CURRENT_TAG" \
    AllowedSourceIp="YOUR.PUBLIC.IP/32" \
    ApiToken="YOUR_TOKEN"
```

Then at your DNS provider:

| Type | Name | Target |
| --- | --- | --- |
| CNAME or Alias (A) | `od.example.com` | value of stack output `AlbDnsName` |

Propagation can take minutes to hours. Then:

```bash
./deploy/aws/redeploy-local.sh
curl -fsS "https://od.example.com/api/health"
```

### Why not HTTPS on the raw ALB name?

ACM will not issue a publicly trusted cert for Amazon’s `*.elb.amazonaws.com` names. HTTP-only ALB DNS is fine for private IP-allowlisted testing; production should use a custom domain + ACM.

---

## Security model (what to keep tight)

| Layer | What it does | Your job |
| --- | --- | --- |
| ALB security group | Only `AllowedSourceIp` can reach :80/:443 | Update CIDR when your IP/VPN changes |
| Nginx auth-proxy | Injects API bearer for `/api/` | Rotate `ApiToken` via Secrets Manager + stack/param update |
| `OD_ALLOWED_ORIGINS` | Browser Origin allowlist | Must match the exact URL users type (`http://` vs `https://`, **lowercase** host) |
| Host/Origin rewrite | Daemon treats proxy as loopback for local-origin guards | Kept by `redeploy-local.sh` and current `template.yaml` |
| EFS + private subnets | App not on a public IP | Don’t move tasks to public subnets without a plan |
| Single task | Avoids SQLite corruption | Don’t raise DesiredCount without a different storage story |

### Origin casing

Browsers send `Origin` with a **lowercase** host. ALB DNS from CloudFormation can be mixed-case. Always allowlist the lowercase form (the redeploy script lowercases `AlbDnsName`).

### Updating the allowlisted IP

```bash
# Get your current public IP, then:
aws cloudformation deploy \
  --template-file deploy/aws/template.yaml \
  --stack-name open-design-stack \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
    AllowedSourceIp="NEW.IP.HERE/32" \
    # …also pass DockerImage, ApiToken, and any CustomDomain/ACM params you already use
```

Or edit the ALB security group inbound rule in the EC2 console for a quick temporary fix, then sync CFN later.

### Rotating the API token

1. Generate a new token (`openssl rand -hex 32`)
2. Update Secrets Manager secret used by the stack (or redeploy stack with new `ApiToken` parameter)
3. Force a new ECS deployment so tasks pick up the secret
4. Update any local notes / password manager copies

---

## Day-2 operations cheat sheet

```bash
REGION=us-east-1
STACK=open-design-stack

# App URL / ALB DNS
aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
  --query 'Stacks[0].Outputs' --output table

# Service health
CLUSTER=$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --logical-resource-id EcsCluster --query 'StackResources[0].PhysicalResourceId' --output text)
SERVICE=$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --logical-resource-id EcsService --query 'StackResources[0].PhysicalResourceId' --output text)
aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" --region "$REGION" \
  --query 'services[0].{running:runningCount,desired:desiredCount,taskDef:taskDefinition}'

# Logs
aws logs tail "/ecs/${STACK}/opendesign-app" --region "$REGION" --follow

# Health via ALB (HTTP) or custom domain (HTTPS)
curl -fsS "http://$(aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='AlbDnsName'].OutputValue" --output text | tr '[:upper:]' '[:lower:]')/api/health"
```

Force a restart without rebuilding:

```bash
aws ecs update-service --cluster "$CLUSTER" --service "$SERVICE" \
  --force-new-deployment --region "$REGION"
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Browser 403 on `/api/*` with Origin errors | `OD_ALLOWED_ORIGINS` missing/mismatched/cased wrong | Redeploy script or set origin to exact lowercase URL users use |
| 403 / local-daemon guards fail behind ALB | Proxy forwarding public `Host`/`Origin` | Auth-proxy must rewrite to `127.0.0.1:${OD_WEB_PORT}` (current template + script) |
| UI version ≠ your laptop | Stack still on GHCR `latest` | Run `./deploy/aws/redeploy-local.sh` |
| Health timeout / can’t open ALB | IP not in `AllowedSourceIp` | Update SG / stack CIDR |
| “Not Secure” in browser | HTTP ALB DNS | Add custom domain + ACM (section above) |
| AMR / Vela sign-in 500 | Image lacks `vela`; not Clerk | Redeploy script disables AMR bootstrap; Clerk is separate (`OD_CLERK_ISSUER`) |
| Stack update resets image to old GHCR tag | CFN `DockerImage` param still old | Pass current ECR tag in `--parameter-overrides`, or redeploy-local after stack update |
| EFS create failed | Missing default EFS KMS alias | Create CMK / fix encryption key |

---

## Cost and teardown notes

- **Default (economy):** ALB, small Fargate, EFS, CloudWatch logs, Secrets Manager. No NAT.
- **Performance:** same, but 4 vCPU / 16 GB Fargate. Flip back after the demo — leaving it on is ~5–6× the compute bill.
- **EFS** has `DeletionPolicy: Retain` — deleting the stack does **not** delete the filesystem. Delete the EFS volume manually in the console if you intend to destroy data.
- To stop burn without deleting everything: `./deploy/aws/set-mode.sh stop` (desired count `0`), or delete the stack (then clean retained EFS/KMS if needed).

```bash
aws ecs update-service --cluster "$CLUSTER" --service "$SERVICE" \
  --desired-count 0 --region "$REGION"
```

---

## Template vs live task definition

- First deploy: CloudFormation owns the task definition.
- `redeploy-local.sh` registers **new revisions** of family `opendesign-app` and points the service at them (outside a CFN parameter bump).
- A later `cloudformation deploy` that changes the task definition resource can create another revision from the template — always pass your **current ECR image** as `DockerImage`, and run `redeploy-local.sh` afterward if you need the script’s app entrypoint / origin fixes reapplied.

The auth-proxy Host/Origin loopback rewrite is now in `template.yaml` so fresh stack creates/updates match production behavior.
