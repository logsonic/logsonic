#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { createReadStream } = require('fs');
const readline = require('readline');
const { program } = require('commander');
const { CloudWatchLogsClient, CreateLogGroupCommand, CreateLogStreamCommand, PutLogEventsCommand, DescribeLogStreamsCommand } = require('@aws-sdk/client-cloudwatch-logs');

// Define the CLI options
program
  .name('upload-to-cloudwatch')
  .description('Upload a large log file to AWS CloudWatch Logs')
  .version('1.0.0')
  .requiredOption('-f, --file <path>', 'Path to the log file to upload')
  .requiredOption('-g, --log-group <name>', 'CloudWatch log group name')
  .requiredOption('-s, --log-stream <name>', 'CloudWatch log stream name')
  .option('-r, --region <region>', 'AWS region', 'us-east-1')
  .option('-p, --profile <profile>', 'AWS profile to use', 'default')
  .option('-b, --batch-size <size>', 'Number of log entries per batch', 1000)
  .option('-c, --create', 'Create log group and stream if they do not exist')
  .option('-t, --timestamp-format <format>', 'Timestamp format in the log file (auto|none|prefix)', 'auto')
  .parse(process.argv);

// Get the options
const options = program.opts();

// Configure AWS SDK
const clientConfig = {
  region: options.region
};

// If profile is specified, use it
if (options.profile && options.profile !== 'default') {
  process.env.AWS_PROFILE = options.profile;
}

async function main() {
  try {
    // Create CloudWatch Logs client
    const client = new CloudWatchLogsClient(clientConfig);
    console.log(`Configured AWS CloudWatch Logs client for region: ${options.region}`);

    // Create log group and stream if required
    if (options.create) {
      try {
        console.log(`Creating log group: ${options.logGroup}`);
        await client.send(new CreateLogGroupCommand({
          logGroupName: options.logGroup
        }));
      } catch (error) {
        if (error.name !== 'ResourceAlreadyExistsException') {
          throw error;
        }
        console.log(`Log group already exists: ${options.logGroup}`);
      }

      try {
        console.log(`Creating log stream: ${options.logStream}`);
        await client.send(new CreateLogStreamCommand({
          logGroupName: options.logGroup,
          logStreamName: options.logStream
        }));
      } catch (error) {
        if (error.name !== 'ResourceAlreadyExistsException') {
          throw error;
        }
        console.log(`Log stream already exists: ${options.logStream}`);
      }
    }

    // Get the current sequence token if the stream exists
    let sequenceToken = null;
    try {
      const streamResponse = await client.send(new DescribeLogStreamsCommand({
        logGroupName: options.logGroup,
        logStreamNamePrefix: options.logStream
      }));

      const stream = streamResponse.logStreams.find(s => s.logStreamName === options.logStream);
      if (stream) {
        sequenceToken = stream.uploadSequenceToken;
        console.log(`Found existing log stream with sequence token: ${sequenceToken}`);
      }
    } catch (error) {
      console.error('Error getting sequence token:', error.message);
      if (!options.create) {
        throw new Error('Log stream does not exist and --create option is not specified');
      }
    }

    // Upload the log file
    await uploadLogFile(client, options.file, options.logGroup, options.logStream, options.batchSize, sequenceToken, options.timestampFormat);

  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

async function uploadLogFile(client, filePath, logGroupName, logStreamName, batchSize, sequenceToken, timestampFormat) {
  console.log(`Uploading file: ${filePath} to ${logGroupName}/${logStreamName}`);
  
  // Check if file exists and is readable
  if (!fs.existsSync(filePath)) {
    throw new Error(`File does not exist: ${filePath}`);
  }
  
  // Create a readable stream for the file
  const fileStream = createReadStream(filePath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });

  let logEvents = [];
  let lineCount = 0;
  let batchCount = 0;

  console.log(`Processing log file with batch size: ${batchSize}`);

  for await (const line of rl) {
    lineCount++;
    
    if (!line.trim()) continue; // Skip empty lines
    
    let timestamp = Date.now(); // Default to current time
    let message = line;
    
    // Handle timestamp extraction based on format
    if (timestampFormat === 'auto') {
      // Try to extract ISO-8601 timestamp from the beginning of the line
      const match = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))\s+(.*)$/);
      if (match) {
        const parsedTime = new Date(match[1]).getTime();
        if (!isNaN(parsedTime)) {
          timestamp = parsedTime;
          message = match[2];
        }
      }
    } else if (timestampFormat === 'prefix') {
      // Extract timestamp assuming it's the first "word" in the line
      const parts = line.split(/\s+/, 2);
      if (parts.length > 1) {
        const parsedTime = new Date(parts[0]).getTime();
        if (!isNaN(parsedTime)) {
          timestamp = parsedTime;
          message = line.substring(parts[0].length).trim();
        }
      }
    }
    
    logEvents.push({
      timestamp,
      message
    });
    
    // If we've reached the batch size, send the logs
    if (logEvents.length >= batchSize) {
      sequenceToken = await sendLogs(client, logGroupName, logStreamName, logEvents, sequenceToken);
      batchCount++;
      console.log(`Sent batch ${batchCount} (${logEvents.length} log events)`);
      logEvents = [];
    }
  }
  
  // Send any remaining logs
  if (logEvents.length > 0) {
    await sendLogs(client, logGroupName, logStreamName, logEvents, sequenceToken);
    batchCount++;
    console.log(`Sent final batch ${batchCount} (${logEvents.length} log events)`);
  }
  
  console.log(`Done! Uploaded ${lineCount} log lines in ${batchCount} batches`);
}

async function sendLogs(client, logGroupName, logStreamName, logEvents, sequenceToken) {
  // Sort log events by timestamp as required by CloudWatch
  logEvents.sort((a, b) => a.timestamp - b.timestamp);
  
  const params = {
    logGroupName,
    logStreamName,
    logEvents
  };
  
  if (sequenceToken) {
    params.sequenceToken = sequenceToken;
  }
  
  try {
    const command = new PutLogEventsCommand(params);
    const response = await client.send(command);
    return response.nextSequenceToken;
  } catch (error) {
    if (error.name === 'InvalidSequenceTokenException') {
      console.log(`Invalid sequence token. Retrying with correct token: ${error.expectedSequenceToken}`);
      params.sequenceToken = error.expectedSequenceToken;
      const command = new PutLogEventsCommand(params);
      const response = await client.send(command);
      return response.nextSequenceToken;
    } else {
      throw error;
    }
  }
}

main().catch(error => {
  console.error('Unhandled error:', error);
  process.exit(1);
}); 