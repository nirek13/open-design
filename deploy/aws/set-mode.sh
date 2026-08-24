#!/usr/bin/env bash
# Switch the Open Design AWS stack between economy (cheap) and performance
# (VC demo) without rebuilding the image.
#
# Usage:
#   ./deploy/aws/set-mode.sh economy
#   ./deploy/aws/set-mode.sh performance
#   ./deploy/aws/set-mode.sh stop          # desired count 0; EFS data kept
#   ./deploy/aws/set-mode.sh status
#
#   STACK=open-design-stack REGION=us-east-1 ./deploy/aws/set-mode.sh economy
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
STACK="${STACK:-open-design-stack}"
REGION="${REGION:-us-east-1}"
MODE="${1:-}"

usage() {
  sed -n '2,13p' "$0"
  exit 2
}

case "$MODE" in
  economy|performance|stop|status) ;;
  -h|--help|'') usage ;;
  *)
    echo "Unknown mode: $MODE (expected economy|performance|stop|status)" >&2
    exit 2
    ;;
esac

need() { command -v "$1" >/dev/null 2>&1 || { echo "Missing required command: $1" >&2; exit 1; }; }
need aws

param() {
  aws cloudformation describe-stacks \
    --stack-name "$STACK" --region "$REGION" \
    --query "Stacks[0].Parameters[?ParameterKey=='$1'].ParameterValue" \
    --output text
}

output() {
  aws cloudformation describe-stacks \
    --stack-name "$STACK" --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" \
    --output text
}

CLUSTER="$(aws cloudformation describe-stack-resources \
  --stack-name "$STACK" --region "$REGION" \
  --logical-resource-id EcsCluster \
  --query 'StackResources[0].PhysicalResourceId' --output text)"
SERVICE="$(aws cloudformation describe-stack-resources \
  --stack-name "$STACK" --region "$REGION" \
  --logical-resource-id EcsService \
  --query 'StackResources[0].PhysicalResourceId' --output text)"

print_status() {
  local operating desired running td cpu mem
  operating="$(param OperatingMode)"
  desired="$(param DesiredCount)"
  running="$(aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" --region "$REGION" \
    --query 'services[0].runningCount' --output text)"
  td="$(aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" --region "$REGION" \
    --query 'services[0].taskDefinition' --output text)"
  cpu="$(aws ecs describe-task-definition --task-definition "$td" --region "$REGION" \
    --query 'taskDefinition.cpu' --output text)"
  mem="$(aws ecs describe-task-definition --task-definition "$td" --region "$REGION" \
    --query 'taskDefinition.memory' --output text)"
  echo "Stack:    $STACK ($REGION)"
  echo "Mode:     ${operating:-unknown}"
  echo "Desired:  ${desired:-?}   Running: ${running:-?}"
  echo "Task:     ${cpu:-?} CPU / ${mem:-?} MB"
  echo "App URL:  $(output AppUrl)"
}

if [[ "$MODE" == status ]]; then
  print_status
  exit 0
fi

# Keep the image the service is actually running (redeploy-local.sh tags), not
# a stale DockerImage parameter that would roll the UI back to GHCR.
CURRENT_TD="$(aws ecs describe-services \
  --cluster "$CLUSTER" --services "$SERVICE" --region "$REGION" \
  --query 'services[0].taskDefinition' --output text)"
CURRENT_IMAGE="$(aws ecs describe-task-definition \
  --task-definition "$CURRENT_TD" --region "$REGION" \
  --query "taskDefinition.containerDefinitions[?name=='app'].image | [0]" \
  --output text)"

OVERRIDES=( )
if [[ -n "$CURRENT_IMAGE" && "$CURRENT_IMAGE" != None ]]; then
  OVERRIDES+=( "DockerImage=$CURRENT_IMAGE" )
fi

case "$MODE" in
  economy)
    OVERRIDES+=( "OperatingMode=economy" "DesiredCount=1" )
    echo "==> Switching $STACK to economy (no NAT, small Fargate unless TaskSize was set)"
    ;;
  performance)
    OVERRIDES+=( "OperatingMode=performance" "DesiredCount=1" )
    echo "==> Switching $STACK to performance (4 vCPU / 16 GB, long ALB idle timeout)"
    ;;
  stop)
    OVERRIDES+=( "DesiredCount=0" "OperatingMode=economy" )
    echo "==> Parking $STACK (desired count 0, economy). EFS data is kept; ALB still bills."
    ;;
esac

echo "==> Image: ${CURRENT_IMAGE:-<stack parameter>}"
aws cloudformation deploy \
  --template-file "$ROOT/deploy/aws/template.yaml" \
  --stack-name "$STACK" \
  --capabilities CAPABILITY_IAM \
  --region "$REGION" \
  --no-fail-on-empty-changeset \
  --parameter-overrides "${OVERRIDES[@]}"

echo "==> Waiting for ECS service stability"
aws ecs wait services-stable \
  --cluster "$CLUSTER" \
  --services "$SERVICE" \
  --region "$REGION"

print_status
echo
echo "Flip back with: ./deploy/aws/set-mode.sh economy"
echo "Leave performance on only for the demo — it is ~5–6x the Fargate bill."
