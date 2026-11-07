#!/usr/bin/env bash
# Runs inside the LocalStack container once SQS is ready.
# Creates the FIFO queue pair used by the wagering processor.
set -euo pipefail

MAIN_QUEUE="wager-transactions.fifo"
DLQ_QUEUE="wager-transactions-dlq.fifo"
MAX_RECEIVES=5

echo "[init] creating DLQ queue: ${DLQ_QUEUE}"
DLQ_URL=$(awslocal sqs create-queue \
  --queue-name "${DLQ_QUEUE}" \
  --attributes '{"FifoQueue":"true","ContentBasedDeduplication":"false"}' \
  --query 'QueueUrl' --output text)

DLQ_ARN=$(awslocal sqs get-queue-attributes \
  --queue-url "${DLQ_URL}" \
  --attribute-names QueueArn \
  --query 'Attributes.QueueArn' --output text)

echo "[init] creating main queue: ${MAIN_QUEUE} (redrive -> ${DLQ_QUEUE}, maxReceiveCount=${MAX_RECEIVES})"
awslocal sqs create-queue \
  --queue-name "${MAIN_QUEUE}" \
  --attributes "{\"FifoQueue\":\"true\",\"ContentBasedDeduplication\":\"false\",\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"${DLQ_ARN}\\\",\\\"maxReceiveCount\\\":${MAX_RECEIVES}}\"}" \
  --query 'QueueUrl' --output text

echo "[init] creating events queue: wager-events.fifo"
awslocal sqs create-queue \
  --queue-name wager-events.fifo \
  --attributes '{"FifoQueue":"true","ContentBasedDeduplication":"false"}' \
  --query 'QueueUrl' --output text

echo "[init] queues ready."
