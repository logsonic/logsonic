


## Grok Patterns

A log file needs to be parsed into a structured format before it can be analyzed. Grok patterns are used to parse the log file. 
Unfortunately, there is no fully reliable way to parse the log file using grok patterns in the browser. 
Therefore, the log file is parsed on the server side. In order to show the results in the browser, the results are sent to the browser. 

The list of grok patterns is kept at server side. The autosuggest function evaluates the grok 
patterns on the given sample of logs and returns the patterns with the matching score. 

A user may try parsing the log with the custom pattern as well. In that case, the score is returned
using custom grok pattern.

While a list of pattern is kept in the file, not all patterns are compiled and kept into memory. 
This is because we don't want to the tokenizer to match multiple patterns while parsing a single log line for performance reasons.



# Ingestion 
The logs could be ingested from a local file or from API. More ingestion options will be added in the future.

# Tokenizer
Tokenizer is how we parse and understand the logs. A grok pattern must be added before the log is ingested, so that log is properly parsed.

# Log retreival
A webview is used to display the logs. The top level search field handles the time range and top level filters. E.g. I could query for log file name type and timestamp range.. 

It is important to differentiate between search and filter. Search would include time range and specific log patterns. Filter would be applied on the client side on top of searched results. 

# Log Filtering
The filtering menu is the left hand side of the UI. It contains all the fields that can be filtered on. 

# Log Analysis
A pipeline could be applied to the logs to create derived fields. However, these derived fields are local in the browser and not sent back to the server. 


# Log Visualization

