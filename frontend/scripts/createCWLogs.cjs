const { CloudWatchLogsClient, CreateLogGroupCommand, PutLogEventsCommand, CreateLogStreamCommand } = require('@aws-sdk/client-cloudwatch-logs');
const { fromEnv } = require('@aws-sdk/credential-providers');

// Configuration
const config = {
  region: 'us-east-1', // Change to your preferred region
  logGroupPrefix: '/logsonic-test',
  numberOfGroups: 3,
  numberOfStreams: 2, // Per group
  numberOfLogs: 50, // Per stream
  timeSpanDays: 5  // Create separate batches for different days
};

// Sample log messages for testing
const logMessages = [
  'ERROR Failed to connect to database after 3 retries',
  'INFO Server started successfully on port 8080',
  'WARN Connection pool reaching maximum capacity (80%)',
  'DEBUG Processing request: GET /api/users',
  'INFO User authenticated: user_id=12345',
  'ERROR Exception in thread "main" java.lang.NullPointerException',
  'WARN Slow query detected: SELECT * FROM users WHERE last_login > ?',
  'INFO Cache hit ratio: 78.3%',
  'DEBUG Loaded configuration from: /etc/myapp/config.json',
  'ERROR 500 Internal Server Error: Division by zero'
];

// Random date within a 24-hour period on a specific day
function getRandomDateInDay(daysAgo) {
  const now = new Date();
  const startOfDay = new Date(now);
  startOfDay.setDate(now.getDate() - daysAgo);
  startOfDay.setHours(0, 0, 0, 0);
  
  const endOfDay = new Date(startOfDay);
  endOfDay.setHours(23, 59, 59, 999);
  
  return new Date(startOfDay.getTime() + Math.random() * (endOfDay.getTime() - startOfDay.getTime()));
}

// Create CloudWatch client
const client = new CloudWatchLogsClient({
  region: config.region,
  credentials: fromEnv()
});

// Split log events into batches that don't exceed 24 hours
function splitLogEventsIntoBatches(logEvents) {
  // Sort log events by timestamp first
  logEvents.sort((a, b) => a.timestamp - b.timestamp);
  
  const batches = [];
  let currentBatch = [];
  let batchStartTime = null;
  
  for (const event of logEvents) {
    if (batchStartTime === null) {
      batchStartTime = event.timestamp;
      currentBatch.push(event);
    } else {
      // Check if adding this event would make the batch span more than 24 hours
      const twentyFourHoursInMs = 24 * 60 * 60 * 1000;
      if (event.timestamp - batchStartTime > twentyFourHoursInMs) {
        // Start a new batch
        batches.push(currentBatch);
        currentBatch = [event];
        batchStartTime = event.timestamp;
      } else {
        currentBatch.push(event);
      }
    }
  }
  
  // Add the last batch if it's not empty
  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }
  
  return batches;
}

// Main function
async function createSampleCloudWatchLogs() {
  try {
    console.log('Starting CloudWatch logs creation...');
    
    for (let i = 1; i <= config.numberOfGroups; i++) {
      const logGroupName = `${config.logGroupPrefix}-group-${i}`;
      
      // Create log group
      console.log(`Creating log group: ${logGroupName}`);
      try {
        await client.send(new CreateLogGroupCommand({
          logGroupName
        }));
        console.log(`  ✅ Log group created: ${logGroupName}`);
      } catch (error) {
        if (error.name === 'ResourceAlreadyExistsException') {
          console.log(`  ⚠️ Log group already exists: ${logGroupName}`);
        } else {
          throw error;
        }
      }
      
      // Create log streams for this group
      for (let j = 1; j <= config.numberOfStreams; j++) {
        const logStreamName = `stream-${j}`;
        
        // Create log stream
        console.log(`  Creating log stream: ${logStreamName}`);
        try {
          await client.send(new CreateLogStreamCommand({
            logGroupName,
            logStreamName
          }));
          console.log(`    ✅ Log stream created: ${logStreamName}`);
        } catch (error) {
          if (error.name === 'ResourceAlreadyExistsException') {
            console.log(`    ⚠️ Log stream already exists: ${logStreamName}`);
          } else {
            throw error;
          }
        }
        
        // Create log events for different days
        console.log(`    Adding log events across ${config.timeSpanDays} days...`);
        
        // Create separate batches of logs for each day
        for (let day = 0; day < config.timeSpanDays; day++) {
          const logsPerDay = Math.ceil(config.numberOfLogs / config.timeSpanDays);
          const logEvents = [];
          
          console.log(`      Creating batch for ${day} days ago...`);
          
          // Create log events with timestamps within a single day
          for (let k = 0; k < logsPerDay; k++) {
            const randomLogIndex = Math.floor(Math.random() * logMessages.length);
            const timestamp = getRandomDateInDay(day);
            
            logEvents.push({
              message: `${logMessages[randomLogIndex]} (day ${day}, log ${k+1})`,
              timestamp: timestamp.getTime()
            });
          }
          
          // Sort log events by timestamp (required by CloudWatch)
          logEvents.sort((a, b) => a.timestamp - b.timestamp);
          
          // Send log events to CloudWatch
          try {
            await client.send(new PutLogEventsCommand({
              logGroupName,
              logStreamName,
              logEvents
            }));
            console.log(`      ✅ Batch for ${day} days ago added successfully`);
          } catch (error) {
            console.error(`      ❌ Failed to add log events for day ${day}:`, error);
          }
          
          // Add a small delay between batches to avoid throttling
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }
    }
    
    console.log('\nSummary:');
    console.log(`  Created ${config.numberOfGroups} log groups`);
    console.log(`  Created ${config.numberOfGroups * config.numberOfStreams} log streams`);
    console.log(`  Added logs across ${config.timeSpanDays} days`);
    console.log('\nYou can now use these log groups for testing:');
    for (let i = 1; i <= config.numberOfGroups; i++) {
      console.log(`  - ${config.logGroupPrefix}-group-${i}`);
    }
    
  } catch (error) {
    console.error('Error creating CloudWatch logs:', error);
  }
}

// Run the script
createSampleCloudWatchLogs();