#!/usr/bin/env bash
# Build the local repo into an amd64 image, push to ECR, and roll the ECS service.
#
# Usage:
#   ./deploy/aws/redeploy-local.sh
#   ./deploy/aws/redeploy-local.sh --watch          # rebuild on source changes
#   STACK=open-design-stack REGION=us-east-1 ./deploy/aws/redeploy-local.sh
#
#   OPENAI_SECRET_ARN=arn:aws:secretsmanager:... ./deploy/aws/redeploy-local.sh
#
# Keeps the auth-proxy Host/Origin loopback rewrite and disables AMR/Vela bootstrap.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
STACK="${STACK:-open-design-stack}"
REGION="${REGION:-us-east-1}"
CLUSTER="${CLUSTER:-}"
SERVICE="${SERVICE:-}"
ECR_REPO="${ECR_REPO:-open-design}"
WATCH=0

for arg in "$@"; do
  case "$arg" in
    --watch) WATCH=1 ;;
    -h|--help)
      sed -n '2,12p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown arg: $arg" >&2
      exit 2
      ;;
  esac
done

need() { command -v "$1" >/dev/null 2>&1 || { echo "Missing required command: $1" >&2; exit 1; }; }
need aws
need docker
need python3
need git

ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
ECR_URI="${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/${ECR_REPO}"

if [[ -z "$CLUSTER" ]]; then
  CLUSTER="$(aws cloudformation describe-stack-resources \
    --stack-name "$STACK" --region "$REGION" \
    --logical-resource-id EcsCluster \
    --query 'StackResources[0].PhysicalResourceId' --output text)"
fi
if [[ -z "$SERVICE" ]]; then
  SERVICE="$(aws cloudformation describe-stack-resources \
    --stack-name "$STACK" --region "$REGION" \
    --logical-resource-id EcsService \
    --query 'StackResources[0].PhysicalResourceId' --output text)"
fi

ALB_DNS="$(aws cloudformation describe-stacks \
  --stack-name "$STACK" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='AlbDnsName'].OutputValue" --output text \
  | tr '[:upper:]' '[:lower:]')"
ALLOWED_ORIGIN="http://${ALB_DNS}"

APP_URL="$(aws cloudformation describe-stacks \
  --stack-name "$STACK" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='AppUrl'].OutputValue" --output text)"
if [[ "$APP_URL" == https://* ]]; then
  ALLOWED_ORIGIN="$(printf '%s' "$APP_URL" | tr '[:upper:]' '[:lower:]')"
fi

PROXY_COMMAND=$(cat <<'NGINX'
cat << 'EOF' > /tmp/default.conf.template
server {
    listen ${PROXY_PORT};
    location / {
        proxy_pass http://${OD_BIND_HOST}:${OD_WEB_PORT};
        proxy_set_header Host 127.0.0.1:${OD_WEB_PORT};
        proxy_set_header Origin http://127.0.0.1:${OD_WEB_PORT};
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
    }
    location /api/ {
        proxy_pass http://${OD_BIND_HOST}:${OD_WEB_PORT};
        proxy_set_header Host 127.0.0.1:${OD_WEB_PORT};
        proxy_set_header Origin http://127.0.0.1:${OD_WEB_PORT};
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header Authorization "Bearer ${PROXY_API_TOKEN}";
        proxy_buffering off;
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
        proxy_set_header Connection '';
    }
}
EOF
envsubst '$PROXY_PORT $OD_BIND_HOST $OD_WEB_PORT $PROXY_API_TOKEN' < /tmp/default.conf.template > /etc/nginx/conf.d/default.conf
exec nginx -g "daemon off;"
NGINX
)

APP_COMMAND=$(cat <<'APP'
set -eu
rm -rf /app/.od/vela-0.0.27 /home/open-design/.amr || true
unset VELA_BIN VELA_OPENCODE_BIN VELA_TARBALL_URL || true
exec node apps/daemon/dist/cli.js --no-open
APP
)

redeploy_once() {
  local sha stamp tag image
  sha="$(git -C "$ROOT" rev-parse --short=9 HEAD)"
  stamp="$(date -u +%Y%m%d%H%M%S)"
  tag="local-${sha}-${stamp}"
  image="${ECR_URI}:${tag}"

  echo "==> Building ${image}"
  docker build --platform linux/amd64 -f "$ROOT/deploy/Dockerfile" -t "$image" "$ROOT"

  echo "==> Logging into ECR"
  aws ecr get-login-password --region "$REGION" \
    | docker login --username AWS --password-stdin "${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com"

  if ! aws ecr describe-repositories --repository-names "$ECR_REPO" --region "$REGION" >/dev/null 2>&1; then
    aws ecr create-repository --repository-name "$ECR_REPO" --region "$REGION" >/dev/null
  fi

  echo "==> Pushing ${image}"
  docker push "$image"

  echo "==> Registering task definition (image=${tag}, origin=${ALLOWED_ORIGIN})"
  local current_td task_json new_td new_arn
  current_td="$(aws ecs describe-services \
    --cluster "$CLUSTER" --services "$SERVICE" --region "$REGION" \
    --query 'services[0].taskDefinition' --output text)"

  task_json="$(aws ecs describe-task-definition \
    --task-definition "$current_td" --region "$REGION" \
    --query 'taskDefinition' --output json)"

  # Heredoc would steal stdin from python `-`; use -c so the pipe is the JSON payload.
  new_td="$(printf '%s' "$task_json" | ALLOWED_ORIGIN="$ALLOWED_ORIGIN" IMAGE="$image" \
    PROXY_COMMAND="$PROXY_COMMAND" APP_COMMAND="$APP_COMMAND" \
    OPENAI_SECRET_ARN="${OPENAI_SECRET_ARN:-}" \
    python3 -c '
import json, os, sys

td = json.load(sys.stdin)
image = os.environ["IMAGE"]
origin = os.environ["ALLOWED_ORIGIN"]
proxy_cmd = os.environ["PROXY_COMMAND"]
app_cmd = os.environ["APP_COMMAND"]
openai_arn = os.environ.get("OPENAI_SECRET_ARN", "").strip()

for key in (
    "taskDefinitionArn", "revision", "status", "requiresAttributes",
    "compatibilities", "registeredAt", "registeredBy",
):
    td.pop(key, None)

for c in td["containerDefinitions"]:
    if c["name"] == "app":
        c["image"] = image
        c["entryPoint"] = ["/bin/sh", "-c"]
        c["command"] = [app_cmd]
        env = {e["name"]: e for e in c.get("environment") or []}
        env["OD_ALLOWED_ORIGINS"] = {"name": "OD_ALLOWED_ORIGINS", "value": origin}
        env.setdefault("OD_BIND_HOST", {"name": "OD_BIND_HOST", "value": "127.0.0.1"})
        env.setdefault("OD_PORT", {"name": "OD_PORT", "value": "7456"})
        c["environment"] = list(env.values())
        if openai_arn:
            secrets = {s["name"]: s for s in c.get("secrets") or []}
            secrets["OPENAI_API_KEY"] = {"name": "OPENAI_API_KEY", "valueFrom": openai_arn}
            secrets["OD_OPENAI_API_KEY"] = {"name": "OD_OPENAI_API_KEY", "valueFrom": openai_arn}
            c["secrets"] = list(secrets.values())
    elif c["name"] == "auth-proxy":
        c["entryPoint"] = ["/bin/sh", "-c"]
        c["command"] = [proxy_cmd]

print(json.dumps(td))
')"

  new_arn="$(aws ecs register-task-definition \
    --region "$REGION" \
    --cli-input-json "$new_td" \
    --query 'taskDefinition.taskDefinitionArn' --output text)"

  echo "==> Updating service -> ${new_arn}"
  aws ecs update-service \
    --cluster "$CLUSTER" \
    --service "$SERVICE" \
    --task-definition "$new_arn" \
    --force-new-deployment \
    --region "$REGION" >/dev/null

  echo "==> Waiting for service stability"
  aws ecs wait services-stable \
    --cluster "$CLUSTER" \
    --services "$SERVICE" \
    --region "$REGION"

  local health
  health="$(curl -fsS "http://${ALB_DNS}/api/health" || true)"
  echo "==> Deployed ${tag}"
  echo "    App:    ${APP_URL:-http://${ALB_DNS}}"
  echo "    Health: ${health}"
}

if [[ "$WATCH" -eq 1 ]]; then
  if ! command -v fswatch >/dev/null 2>&1; then
    echo "Install fswatch for --watch (brew install fswatch), or run without --watch." >&2
    exit 1
  fi
  echo "Watching ${ROOT}/{apps,packages,deploy} — rebuild on change (Ctrl-C to stop)"
  redeploy_once
  fswatch -o \
    "$ROOT/apps" \
    "$ROOT/packages" \
    "$ROOT/deploy/Dockerfile" \
    "$ROOT/deploy/aws" \
    | while read -r _; do
        echo
        echo "Change detected — redeploying…"
        redeploy_once || echo "Redeploy failed; still watching." >&2
      done
else
  redeploy_once
fi
