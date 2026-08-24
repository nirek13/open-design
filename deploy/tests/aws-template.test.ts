import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Guards the AWS CloudFormation template's cost-mode contract. These checks
// are source-level so they run without AWS credentials.

const repoRoot = join(import.meta.dirname, '../..');
const templatePath = join(repoRoot, 'deploy/aws/template.yaml');
const setModePath = join(repoRoot, 'deploy/aws/set-mode.sh');

async function readTemplate(): Promise<string> {
  return readFile(templatePath, 'utf8');
}

test('template default is economy and does not provision NAT Gateways', async () => {
  const src = await readTemplate();
  assert.match(src, /OperatingMode:/);
  assert.match(src, /Default: economy/);
  assert.match(src, /AllowedValues: \[economy, performance\]/);
  assert.doesNotMatch(
    src,
    /Type:\s*AWS::EC2::NatGateway/,
    'NAT Gateways are the ~$65/mo line item this template is meant to drop',
  );
  assert.doesNotMatch(src, /NatGatewayId:/);
});

test('Fargate is public-IP for outbound; inbound still ALB-only', async () => {
  const src = await readTemplate();
  assert.match(src, /AssignPublicIp:\s*ENABLED/);
  assert.match(src, /SourceSecurityGroupId:\s*!Ref AlbSecurityGroup/);
  assert.match(src, /CidrIp:\s*!Ref AllowedSourceIp/);
});

test('performance mode maxes CPU, memory, disk, ALB idle timeout, and log retention', async () => {
  const src = await readTemplate();
  assert.match(src, /IsPerformance:\s*!Equals \[!Ref OperatingMode, performance\]/);
  assert.match(src, /xlarge:\n\s+Cpu: '4096'\n\s+Memory: '16384'/);
  assert.match(src, /!If \[IsPerformance, xlarge, !Ref TaskSize\]/);
  assert.match(src, /SizeInGiB:\s*!If \[IsPerformance, 100, 21\]/);
  assert.match(src, /idle_timeout\.timeout_seconds/);
  assert.match(src, /!If \[IsPerformance, '4000', '600'\]/);
  assert.match(src, /RetentionInDays:\s*!If \[IsPerformance, 14, 3\]/);
});

test('DesiredCount cannot exceed 1 (SQLite single-writer)', async () => {
  const src = await readTemplate();
  assert.match(src, /DesiredCount:/);
  assert.match(src, /MaxValue: 1/);
  assert.match(src, /DesiredCount:\s*!Ref DesiredCount/);
});

test('set-mode.sh exposes economy, performance, stop, and status', async () => {
  const src = await readFile(setModePath, 'utf8');
  assert.match(src, /economy\|performance\|stop\|status/);
  assert.match(src, /OperatingMode=economy/);
  assert.match(src, /OperatingMode=performance/);
  assert.match(src, /DesiredCount=0/);
  assert.match(src, /DockerImage=/);
});
