
## CloudWatch Log Upload Utility

LogSonic includes a utility script for uploading large log files to AWS CloudWatch Logs. This can be useful for testing or if you need to upload log files to CloudWatch before importing them into LogSonic.

### Installation

The script uses the AWS SDK and Commander for CLI parsing. These are included in the project dependencies. Make sure you have run `npm install` in the frontend directory.

### Usage

```bash
# Navigate to the frontend directory
cd frontend

# Run the script using npm
npm run cloudwatch-upload -- [options]

# Or run it directly
./scripts/upload-to-cloudwatch.js [options]
```

### Options

- `-f, --file <path>`: Path to the log file to upload (required)
- `-g, --log-group <name>`: CloudWatch log group name (required)
- `-s, --log-stream <name>`: CloudWatch log stream name (required)
- `-r, --region <region>`: AWS region (default: "us-east-1")
- `-p, --profile <profile>`: AWS profile to use (default: "default")
- `-b, --batch-size <size>`: Number of log entries per batch (default: 1000)
- `-c, --create`: Create log group and stream if they do not exist
- `-t, --timestamp-format <format>`: Timestamp format in the log file (auto|none|prefix) (default: "auto")

### Examples

```bash
# Upload a log file to CloudWatch, creating the log group and stream if needed
npm run cloudwatch-upload -- -f path/to/logs.txt -g my-log-group -s my-log-stream -c

# Upload with a specific AWS profile and region
npm run cloudwatch-upload -- -f path/to/logs.txt -g my-log-group -s my-log-stream -p prod -r us-west-2

# Upload with custom timestamp parsing
npm run cloudwatch-upload -- -f path/to/logs.txt -g my-log-group -s my-log-stream -t prefix
```

The timestamp formats supported are:
- `auto`: Automatically detect ISO-8601 timestamps at the beginning of lines
- `none`: Don't extract timestamps, use current time for all entries
- `prefix`: Extract timestamp from the first field of each line







