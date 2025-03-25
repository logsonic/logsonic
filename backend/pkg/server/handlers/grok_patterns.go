// Package handlers provides HTTP handlers for the server
package handlers

import (
	"logsonic/pkg/types"
)

// DefaultGrokPatterns returns a list of default Grok patterns to use when creating a new grok.json file
func DefaultGrokPatterns() []types.GrokPatternDefinition {
	return []types.GrokPatternDefinition{
		// Standard System Logs
		{
			Name:        "Syslog",
			Pattern:     "%{SYSLOGTIMESTAMP:timestamp} %{HOSTNAME:hostname} %{PROG:program}(?:\\(%{WORD:facility}\\))?(?:\\[%{POSINT:pid}\\])?: %{GREEDYDATA:message}\\r?$",
			Priority:    1,
			Description: "Standard Syslog Format",
			Type:        "standard",
			// Example: Jan 23 14:05:01 myhost sshd[12345]: Failed password for invalid user username from 192.168.0.1 port 12345 ssh2
		},

		// Web Server Logs
		{
			Name:        "Apache Common Log",
			Pattern:     "%{IPORHOST:clientip} %{USER:ident} %{USER:auth} \\[%{HTTPDATE:timestamp}\\] \"%{WORD:verb} %{NOTSPACE:request}(?: HTTP/%{NUMBER:httpversion})?\" %{NUMBER:response} (?:%{NUMBER:bytes}|-) \"%{DATA:referrer}\" \"%{DATA:agent}\"",
			Priority:    10,
			Description: "Apache Common Log Format",
			Type:        "standard",
			// Example: 192.168.0.1 - - [23/Jan/2023:14:05:01 +0000] "GET /index.html HTTP/1.1" 200 1234 "-" "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
		},
		{
			Name:        "Apache Combined Access Log",
			Pattern:     "%{IPORHOST:clientip} %{USER:ident} %{USER:auth} \\[%{HTTPDATE:timestamp}\\] \"%{WORD:verb} %{NOTSPACE:request}(?: HTTP/%{NUMBER:httpversion})?\" %{NUMBER:response} (?:%{NUMBER:bytes}|-) \"%{DATA:referrer}\" \"%{DATA:agent}\"",
			Priority:    11,
			Description: "Apache HTTP combined log format (Common Log Format + referrer \u0026 user-agent)",
			Type:        "standard",
			// Example: 192.168.0.1 - - [23/Jan/2023:14:05:01 +0000] "GET /index.html HTTP/1.1" 200 1234 "http://google.com" "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
		},
		{
			Name:        "Apache Error Log",
			Pattern:     "\\[%{HTTPDERROR_DATE:timestamp}\\] \\[%{LOGLEVEL:loglevel}\\] \\[client %{IPORHOST:clientip}\\] %{GREEDYDATA:message}",
			Priority:    12,
			Description: "Apache HTTP error log format",
			Type:        "standard",
			CustomPatterns: map[string]string{
				"HTTPDERROR_DATE": "%{DAY} %{MONTH} %{MONTHDAY} %{TIME} %{YEAR}",
			},
			// Example: [Wed Jan 23 14:05:01 2023] [error] [client 192.168.0.1] File does not exist: /var/www/html/favicon.ico
		},
		{
			Name:        "Nginx Access Log",
			Pattern:     "%{IPORHOST:clientip} %{USER:ident} %{USER:auth} \\[%{HTTPDATE:timestamp}\\] \"%{WORD:verb} %{NOTSPACE:request} HTTP/%{NUMBER:httpversion}\" %{NUMBER:status} %{NUMBER:bytes} \"%{DATA:referrer}\" \"%{DATA:agent}\"",
			Priority:    12,
			Description: "Nginx default access log (similar to Apache combined format)",
			Type:        "standard",
			// Example: 192.168.0.1 - - [23/Jan/2023:14:05:01 +0000] "GET /index.html HTTP/1.1" 200 1234 "http://google.com" "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
		},
		{
			Name:        "Nginx Error Log",
			Pattern:     "(?\u003ctimestamp\u003e\\d{4}\\/\\d{2}\\/\\d{2} %{TIME}) \\[%{WORD:level}\\] %{INT:pid}\\#%{INT:tid}: \\*%{INT:conn_id} %{GREEDYDATA:message}",
			Priority:    13,
			Description: "Nginx error log format",
			Type:        "standard",
			// Example: 2023/01/23 14:05:01 [error] 1234#5678: *89 open() "/var/www/html/favicon.ico" failed (2: No such file or directory)
		},
		{
			Name:        "IIS Access Log",
			Pattern:     "%{TIMESTAMP_ISO8601:timestamp} %{IPORHOST:clientip} %{WORD:method} %{URIPATH:request} %{NUMBER:status} %{NUMBER:bytes} %{NUMBER:time_taken}",
			Priority:    14,
			Description: "Microsoft IIS log format",
			Type:        "standard",
			// Example: 2023-01-23 14:05:01 192.168.0.1 GET /index.html 200 1234 567
		},

		// Mobile and Application Logs
		{
			Name:        "Android Log",
			Pattern:     "(?\u003ctimestamp\u003e\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}\\.\\d{3})\\s+%{NUMBER:pid}\\s+%{NUMBER:tid}\\s+%{WORD:level}\\s+%{DATA:tag}\\s*: %{GREEDYDATA:message}\\r?$",
			Priority:    14,
			Description: "Android Logcat Format",
			Type:        "standard",
			CustomPatterns: map[string]string{
				"ANDROID_TIMESTAMP": "\\d\\d-\\d\\d \\d\\d:\\d\\d:\\d\\d.\\d\\d\\d",
			},
			// Example: 01-23 14:05:01.123 1234 5678 D MyApp: Starting application
		},
		{
			Name:        "Java Log",
			Pattern:     "%{TIMESTAMP_ISO8601:timestamp} \\[%{DATA:thread}\\] %{LOGLEVEL:level} %{JAVAFILE:logger} - %{GREEDYDATA:message}",
			Priority:    15,
			Description: "Common Java Log Format",
			Type:        "standard",
			CustomPatterns: map[string]string{
				"JAVACLASS": "[a-zA-Z0-9-]+(?:\\.[a-zA-Z0-9-]+)*",
				"JAVAFILE":  "(?:[A-Za-z0-9-]+\\.)*[A-Za-z0-9-]+",
				"LOGLEVEL":  "(?:ERROR|WARN|INFO|DEBUG|TRACE)",
			},
			// Example: 2023-01-23 14:05:01,123 [main] INFO com.example.MyClass - Application started successfully
		},
		{
			Name:        "Log4j",
			Pattern:     "%{TIMESTAMP_ISO8601:timestamp} %{LOGLEVEL:level} \\[%{DATA:thread}\\] %{JAVACLASS:logger} - %{GREEDYDATA:message}",
			Priority:    16,
			Description: "Log4j standard pattern",
			Type:        "standard",
			CustomPatterns: map[string]string{
				"JAVACLASS": "(?:[A-Za-z0-9-]+\\.)*[A-Za-z0-9-$]+",
			},
			// Example: 2023-01-23 14:05:01,123 INFO [http-nio-8080-exec-1] com.example.controller.UserController - User logged in: user123
		},
		{
			Name:        "iOS Log",
			Pattern:     "%{TIMESTAMP_ISO8601:timestamp} %{LOGLEVEL:level}\\s+%{GREEDYDATA:message} \\[%{DATA:file}:%{INT:line}\\]",
			Priority:    17,
			Description: "Common iOS log format",
			Type:        "standard",
			// Example: 2023-01-23 14:05:01.123 INFO App started successfully [AppDelegate.swift:24]
		},

		// Database Logs
		{
			Name:        "MySQL Error Log",
			Pattern:     "%{TIMESTAMP_ISO8601:timestamp} %{NUMBER:thread_id} \\[%{WORD:level}\\] %{GREEDYDATA:message}",
			Priority:    20,
			Description: "MySQL Error Log Format",
			Type:        "standard",
			// Example: 2023-01-23T14:05:01.123456Z 12345 [Error] Access denied for user 'username'@'localhost'
		},
		{
			Name:        "MySQL Slow Query Log",
			Pattern:     "# Time: %{TIMESTAMP_ISO8601:timestamp}\\s+# User@Host: %{USERNAME:user}\\[%{USERNAME:username}\\] @ (?:%{HOSTNAME:clienthost}|%{IP:clientip}) \\[[^]]*\\]\\s+# Query_time: %{NUMBER:query_time}\\s+Lock_time: %{NUMBER:lock_time}\\s+Rows_sent: %{NUMBER:rows_sent}\\s+Rows_examined: %{NUMBER:rows_examined}\\s+SET timestamp=%{NUMBER:mysql_timestamp};\\s+%{GREEDYDATA:query}",
			Priority:    21,
			Description: "MySQL Slow Query Log Format",
			Type:        "standard",
			CustomPatterns: map[string]string{
				"USERNAME": "[a-zA-Z0-9._-]+",
			},
			// Example: # Time: 2023-01-23T14:05:01.123456Z # User@Host: username[username] @ localhost [] # Query_time: 10.123456 Lock_time: 0.000000 Rows_sent: 1 Rows_examined: 1000000 SET timestamp=1674482701; SELECT * FROM users WHERE name LIKE '%test%';
		},
		{
			Name:        "PostgreSQL Log",
			Pattern:     "%{TIMESTAMP_ISO8601:timestamp} %{TZ} %{USERNAME:user} %{WORD:database} %{USERNAME:pid} %{WORD:client_ip} %{NUMBER:session_id} %{WORD:session_line_num} %{GREEDYDATA:message}",
			Priority:    22,
			Description: "PostgreSQL Log Format",
			Type:        "standard",
			CustomPatterns: map[string]string{
				"USERNAME": "[a-zA-Z0-9._-]+",
			},
			// Example: 2023-01-23 14:05:01.123 UTC postgres database 12345 192.168.0.1 1 0 LOG:  database system is ready to accept connections
		},
		{
			Name:        "PostgreSQL Error Log",
			Pattern:     "%{TIMESTAMP_ISO8601:timestamp} %{TZ} \\[%{NUMBER:pid}\\] %{WORD:user}@%{WORD:database} %{WORD:severity}: %{GREEDYDATA:message}",
			Priority:    26,
			Description: "PostgreSQL Error Log Format",
			Type:        "standard",
			// Example: 2023-01-23 14:05:01.123 UTC [1234] user@mydatabase ERROR: relation "users" does not exist at character 15
		},
		{
			Name:        "MongoDB Log",
			Pattern:     "%{TIMESTAMP_ISO8601:timestamp} %{WORD:severity} %{WORD:component} \\[%{DATA:context}\\] %{GREEDYDATA:message}",
			Priority:    23,
			Description: "MongoDB Log Format",
			Type:        "standard",
			// Example: 2023-01-23T14:05:01.123+0000 I NETWORK [conn1234] connection accepted from 192.168.0.1:56789 #1234
		},
		{
			Name:        "SQLite Log",
			Pattern:     "%{TIMESTAMP_ISO8601:timestamp} %{LOGLEVEL:level} %{GREEDYDATA:message}",
			Priority:    24,
			Description: "SQLite Log Format",
			Type:        "standard",
			// Example: 2023-01-23 14:05:01.123 INFO Database opened successfully
		},
		{
			Name:        "SQL Server Log",
			Pattern:     "%{TIMESTAMP_ISO8601:timestamp} %{WORD:spid} %{LOGLEVEL:severity} %{GREEDYDATA:message}",
			Priority:    25,
			Description: "Microsoft SQL Server Log Format",
			Type:        "standard",
			// Example: 2023-01-23 14:05:01.123 Spid1234 Error: The transaction log for database 'MyDB' is full due to 'LOG_BACKUP'.
		},
		{
			Name:        "Oracle Alert Log",
			Pattern:     "%{DAY} %{MONTH} %{MONTHDAY} %{TIME} %{YEAR}\\nALERT %{WORD:process}\\(%{DATA:instance}\\) \\(%{WORD:host}\\): %{GREEDYDATA:message}",
			Priority:    27,
			Description: "Oracle Database Alert Log Format",
			Type:        "standard",
			// Example: Thu Jan 23 14:05:01 2023\nALERT TNS(ORCL) (myhost): ORA-00600: internal error code, arguments: [1234], [5678], [], [], [], [], [], [], [], [], [], []
		},

		// Container and Orchestration Logs
		{
			Name:        "Kubernetes Pod Log",
			Pattern:     "%{TIMESTAMP_ISO8601:timestamp} %{LOGLEVEL:level} %{GREEDYDATA:message}",
			Priority:    30,
			Description: "Kubernetes Pod Log Format",
			Type:        "standard",
			// Example: 2023-01-23T14:05:01.123Z INFO Starting container
		},
		{
			Name:        "Docker Log",
			Pattern:     "%{TIMESTAMP_ISO8601:timestamp} %{WORD:level} %{GREEDYDATA:message}",
			Priority:    31,
			Description: "Docker Log Format",
			Type:        "standard",
			// Example: 2023-01-23T14:05:01.123Z INFO Container abc123def456 starting
		},
		{
			Name:        "Kubernetes Events",
			Pattern:     "%{TIMESTAMP_ISO8601:timestamp} %{WORD:level} %{WORD:component} %{WORD:object_type}=%{NOTSPACE:object_name} %{GREEDYDATA:message}",
			Priority:    32,
			Description: "Kubernetes Events Log Format",
			Type:        "standard",
			// Example: 2023-01-23T14:05:01.123Z INFO kubelet Pod=myapp-pod-123abc Successfully pulled image
		},

		// Security Logs
		{
			Name:        "Auth Log",
			Pattern:     "%{SYSLOGTIMESTAMP:timestamp} %{HOSTNAME:hostname} %{WORD:program}(?:\\[%{POSINT:pid}\\])?: %{GREEDYDATA:message}",
			Priority:    40,
			Description: "Linux Auth Log Format",
			Type:        "standard",
			// Example: Jan 23 14:05:01 myhost sshd[12345]: Failed password for invalid user username from 192.168.0.1 port 12345 ssh2
		},
		{
			Name:        "SSH Authentication",
			Pattern:     "%{SYSLOGTIMESTAMP:timestamp} %{HOSTNAME:hostname} sshd\\[%{POSINT:pid}\\]: %{DATA:status} %{WORD:auth_method} for( invalid user)? %{USERNAME:username} from %{IP:srcip}( port %{NUMBER:port})?( ssh%{NUMBER:ssh_version})?",
			Priority:    41,
			Description: "SSH Authentication Log Format",
			Type:        "standard",
			CustomPatterns: map[string]string{
				"USERNAME": "[a-zA-Z0-9._-]+",
			},
			// Example: Jan 23 14:05:01 myhost sshd[12345]: Failed password for invalid user username from 192.168.0.1 port 12345 ssh2
		},
		{
			Name:        "Firewall Log",
			Pattern:     "%{SYSLOGTIMESTAMP:timestamp} %{HOSTNAME:hostname} %{WORD:program}(?:\\[%{POSINT:pid}\\])?: %{GREEDYDATA:message}",
			Priority:    42,
			Description: "Firewall Log Format",
			Type:        "standard",
			// Example: Jan 23 14:05:01 myhost kernel[12345]: [UFW BLOCK] IN=eth0 OUT= MAC=00:00:00:00:00:00:00:00:00:00:00:00:00:00 SRC=192.168.0.1 DST=192.168.0.2 LEN=40 TOS=0x00 PREC=0x00 TTL=249 ID=12345 PROTO=TCP SPT=12345 DPT=80 WINDOW=1024 RES=0x00 SYN URGP=0
		},
		{
			Name:        "OWASP ModSecurity",
			Pattern:     "\\[%{HTTPDERROR_DATE:timestamp}\\] \\[%{WORD:client}\\] \\[client %{IPORHOST:clientip}\\] \\[file \"%{DATA:rule_file}\"\\] \\[line \"%{NUMBER:rule_line}\"\\] \\[id \"%{NUMBER:rule_id}\"\\] \\[rev \"%{NUMBER:rule_revision}\"\\] \\[msg \"%{DATA:rule_msg}\"\\] \\[data \"%{DATA:attack_data}\"\\] \\[severity \"%{WORD:severity}\"\\] (?:\\[tag \"%{DATA:tag}\"\\] )*\\[hostname \"%{DATA:hostname}\"\\] \\[uri \"%{DATA:uri}\"\\] \\[unique_id \"%{DATA:unique_id}\"\\]",
			Priority:    45,
			Description: "OWASP ModSecurity WAF Detailed Log Format",
			Type:        "security",
			CustomPatterns: map[string]string{
				"HTTPDERROR_DATE": "%{DAY} %{MONTH} %{MONTHDAY} %{TIME} %{YEAR}",
			},
			// Example: [Wed Jan 23 14:05:01 2023] [error] [client 192.168.0.1] [file "/etc/modsecurity/rules/crs/942100.conf"] [line "44"] [id "942100"] [rev "2"] [msg "SQL Injection Attack"] [data "SELECT FROM users"] [severity "CRITICAL"] [tag "application-multi"] [tag "language-multi"] [tag "platform-multi"] [tag "attack-sqli"] [hostname "example.com"] [uri "/search"] [unique_id "X1qnOfCoAQEAADRvUW8AAAAB"]
		},
		{
			Name:        "Fail2Ban Log",
			Pattern:     "%{TIMESTAMP_ISO8601:timestamp} %{WORD:process}\\s+\\[%{NUMBER:pid}\\]: %{LOGLEVEL:level}\\s+\\[%{WORD:jail}\\] %{WORD:action}: %{IP:source_ip}",
			Priority:    46,
			Description: "Fail2Ban Log Format",
			Type:        "security",
			// Example: 2023-01-23 14:05:01,123 fail2ban[1234]: INFO [sshd] Ban: 192.168.0.1
		},
		{
			Name:        "Snort IDS Alert",
			Pattern:     "\\[\\*\\*\\] \\[%{NUMBER:rule_id}:%{NUMBER:rule_revision}\\] %{DATA:alert_message} \\[\\*\\*\\]\\n\\[Classification: %{DATA:classification}\\] \\[Priority: %{NUMBER:priority}\\]\\n%{TIMESTAMP_ISO8601:timestamp} %{IP:source_ip}:%{NUMBER:source_port} -> %{IP:destination_ip}:%{NUMBER:destination_port}",
			Priority:    47,
			Description: "Snort IDS Alert Log Format",
			Type:        "security",
			// Example: [**] [1:1000001:1] ATTACK-RESPONSES id check returned root [**]\n[Classification: Potentially Bad Traffic] [Priority: 2]\n2023-01-23T14:05:01.123 192.168.0.1:12345 -> 10.0.0.1:80
		},
		{
			Name:        "Suricata EVE JSON",
			Pattern:     "\\{\"timestamp\":\"%{TIMESTAMP_ISO8601:timestamp}\".*\"event_type\":\"%{WORD:event_type}\".*\"src_ip\":\"%{IP:src_ip}\".*\"src_port\":%{NUMBER:src_port}.*\"dest_ip\":\"%{IP:dest_ip}\".*\"dest_port\":%{NUMBER:dest_port}.*\"proto\":\"%{WORD:protocol}\".*(?:\"alert\":\\{.*\"signature\":\"%{DATA:alert_signature}\".*\"signature_id\":%{NUMBER:signature_id}.*\"category\":\"%{DATA:alert_category}\".*\\})?.*\\}",
			Priority:    48,
			Description: "Suricata EVE JSON Log Format",
			Type:        "security",
			// Example: {"timestamp":"2023-01-23T14:05:01.123Z","event_type":"alert","src_ip":"192.168.0.1","src_port":12345,"dest_ip":"10.0.0.1","dest_port":80,"proto":"TCP","alert":{"signature":"ET POLICY SSH Brute Force Attempt","signature_id":2001219,"category":"Attempted Administrator Privilege Gain"}}
		},
		{
			Name:        "OSSEC Alert",
			Pattern:     "\\*\\* Alert %{NUMBER:alert_id}.%{NUMBER:alert_sub_id}:%{SPACE}%{DATA:rule_description}\\n%{TIMESTAMP_ISO8601:timestamp} %{DATA:hostname}->%{DATA:location}\\nRule: %{NUMBER:rule_id} \\(level %{NUMBER:level}\\) -> '%{DATA:rule_name}'\\n(?:Src IP: (?:%{IP:src_ip})\\n)?(?:User: (?:%{DATA:user})\\n)?%{GREEDYDATA:message}",
			Priority:    49,
			Description: "OSSEC HIDS Alert Log Format",
			Type:        "security",
			// Example: ** Alert 1234.5678: authentication success\n2023-01-23T14:05:01.123 server1->sshd\nRule: 1234 (level 3) -> 'User login successful.'\nSrc IP: 192.168.0.1\nUser: admin\n2023-01-23T14:05:01.123 sshd[1234]: Accepted password for admin from 192.168.0.1 port 12345
		},

		// Network Equipment Logs
		{
			Name:        "Cisco IOS Log",
			Pattern:     "^<(?<pri>[0-9]+)>(?<time>[0-9]{1,2}:[0-9]{1,2}:[0-9]{1,2}):\\s+\\*?(?:%{CISCOTIMESTAMP:timestamp})?\\s+(?:%{WORD:device})?:?\\s+%{GREEDYDATA:message}$",
			Priority:    50,
			Description: "Cisco IOS Log Format",
			Type:        "standard",
			CustomPatterns: map[string]string{
				"CISCOTIMESTAMP": "%{MONTH} +%{MONTHDAY}(?: %{YEAR})? %{TIME}",
			},
			// Example: <189>45: *Jan 23 14:05:01.123: %LINK-3-UPDOWN: Interface GigabitEthernet0/1, changed state to down
		},
		{
			Name:        "Juniper Log",
			Pattern:     "%{SYSLOGTIMESTAMP:timestamp} %{HOSTNAME:hostname} %{WORD:program}\\[%{POSINT:pid}\\]: %{GREEDYDATA:message}",
			Priority:    51,
			Description: "Juniper Network Device Log Format",
			Type:        "standard",
			// Example: Jan 23 14:05:01 router1 mgd[1234]: UI_COMMIT: User 'admin' requested 'commit' operation
		},
		{
			Name:        "F5 BIG-IP Log",
			Pattern:     "%{SYSLOGTIMESTAMP:timestamp} %{HOSTNAME:hostname} %{WORD:program}(?:\\[%{POSINT:pid}\\])?: %{GREEDYDATA:message}",
			Priority:    52,
			Description: "F5 BIG-IP Load Balancer Log Format",
			Type:        "standard",
			// Example: Jan 23 14:05:01 lb1 tmm[1234]: Rule /Common/redirect_to_https: /*/*: Redirect to https://example.com/
		},

		// Message Queue and Broker Logs
		{
			Name:        "RabbitMQ Log",
			Pattern:     "%{TIMESTAMP_ISO8601:timestamp} \\[%{WORD:level}\\] %{GREEDYDATA:message}",
			Priority:    60,
			Description: "RabbitMQ Log Format",
			Type:        "standard",
			// Example: 2023-01-23 14:05:01.123 [info] Starting RabbitMQ 3.9.13 on Erlang 24.2
		},
		{
			Name:        "Kafka Log",
			Pattern:     "\\[%{TIMESTAMP_ISO8601:timestamp}\\] %{WORD:level} %{GREEDYDATA:message} \\(%{JAVACLASS:class}\\)",
			Priority:    61,
			Description: "Kafka Log Format",
			Type:        "standard",
			CustomPatterns: map[string]string{
				"JAVACLASS": "(?:[A-Za-z0-9-]+\\.)*[A-Za-z0-9-$]+",
			},
			// Example: [2023-01-23 14:05:01,123] INFO [KafkaServer id=1] started (kafka.server.KafkaServer)
		},

		// Cache Logs
		{
			Name:        "Redis Log",
			Pattern:     "%{NUMBER:pid}:%{WORD:role} %{GREEDYDATA:message}",
			Priority:    70,
			Description: "Redis Log Format",
			Type:        "standard",
			// Example: 1234:M 23 Jan 2023 14:05:01.123 # Server started, Redis version 6.2.6
		},
		{
			Name:        "Memcached Log",
			Pattern:     "%{SYSLOGTIMESTAMP:timestamp} %{WORD:severity} %{GREEDYDATA:message}",
			Priority:    71,
			Description: "Memcached Log Format",
			Type:        "standard",
			// Example: Jan 23 14:05:01 INFO Starting Memcached version 1.6.14
		},

		// API Gateway Logs
		{
			Name:        "AWS API Gateway",
			Pattern:     "%{TIMESTAMP_ISO8601:timestamp} %{UUID:request_id} %{WORD:http_method} %{URIPATH:uri_path} %{NUMBER:status_code} %{NUMBER:response_time} %{IP:source_ip}",
			Priority:    80,
			Description: "AWS API Gateway Log Format",
			Type:        "standard",
			CustomPatterns: map[string]string{
				"UUID": "[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}",
			},
			// Example: 2023-01-23T14:05:01Z c1234abc-def5-67gh-89ij-klmno0123456 GET /api/users 200 45.67 192.168.0.1
		},
		{
			Name:        "Kong API Gateway",
			Pattern:     "%{IP:client_ip} - %{USERNAME:user} \\[%{HTTPDATE:timestamp}\\] \"%{WORD:method} %{URIPATH:uri_path} HTTP/%{NUMBER:http_version}\" %{NUMBER:status_code} %{NUMBER:bytes} %{NUMBER:response_time}",
			Priority:    81,
			Description: "Kong API Gateway Log Format",
			Type:        "standard",
			CustomPatterns: map[string]string{
				"USERNAME": "[a-zA-Z0-9._-]+",
			},
			// Example: 192.168.0.1 - - [23/Jan/2023:14:05:01 +0000] "GET /api/users HTTP/1.1" 200 1234 45.67
		},

		// Serverless Logs
		{
			Name:        "AWS Lambda Log",
			Pattern:     "START RequestId: %{UUID:request_id} Version: %{DATA:version}\\nEND RequestId: %{UUID:request_id}\\nREPORT RequestId: %{UUID:request_id}\\s+Duration: %{NUMBER:duration} ms\\s+Billed Duration: %{NUMBER:billed_duration} ms\\s+Memory Size: %{NUMBER:memory_size} MB\\s+Max Memory Used: %{NUMBER:max_memory_used} MB",
			Priority:    90,
			Description: "AWS Lambda Log Format",
			Type:        "standard",
			CustomPatterns: map[string]string{
				"UUID": "[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}",
			},
			// Example: START RequestId: c1234abc-def5-67gh-89ij-klmno0123456 Version: $LATEST\nEND RequestId: c1234abc-def5-67gh-89ij-klmno0123456\nREPORT RequestId: c1234abc-def5-67gh-89ij-klmno0123456 Duration: 123.45 ms Billed Duration: 124 ms Memory Size: 128 MB Max Memory Used: 45 MB
		},
		{
			Name:        "Azure Function Log",
			Pattern:     "%{TIMESTAMP_ISO8601:timestamp} %{WORD:level} \\[%{DATA:function_name}\\] %{GREEDYDATA:message}",
			Priority:    91,
			Description: "Azure Function Log Format",
			Type:        "standard",
			// Example: 2023-01-23T14:05:01.123Z INFO [MyFunction] Function execution started
		},

		// Load Balancer Logs
		{
			Name:        "HAProxy Log",
			Pattern:     "%{IP:client_ip}:%{INT:client_port} \\[%{HTTPDATE:timestamp}\\] %{NOTSPACE:frontend_name} %{NOTSPACE:backend_name}/%{NOTSPACE:server_name} %{INT:time_request}/%{INT:time_queue}/%{INT:time_backend_connect}/%{INT:time_backend_response}/%{INT:time_duration} %{INT:status_code} %{INT:bytes_read} %{NOTSPACE:captured_request_cookie} %{NOTSPACE:captured_response_cookie} %{NOTSPACE:termination_state} %{INT:actconn}/%{INT:feconn}/%{INT:beconn}/%{INT:srvconn}/%{INT:retries} %{INT:srv_queue}/%{INT:backend_queue} \\{\"%{DATA:captured_request_headers}\"\\} \\{\"%{DATA:captured_response_headers}\"\\} \"%{WORD:http_method} %{URIPATHPARAM:uri_path} HTTP/%{NUMBER:http_version}\"",
			Priority:    100,
			Description: "HAProxy Log Format",
			Type:        "standard",
			// Example: 192.168.0.1:12345 [23/Jan/2023:14:05:01.123] frontend backend/server 1/2/3/4/5 200 1234 - - ---- 1/2/3/4/0 0/0 {"User-Agent: Mozilla/5.0"} {"Server: nginx"} "GET /index.html HTTP/1.1"
		},
		{
			Name:        "AWS ELB Log",
			Pattern:     "%{TIMESTAMP_ISO8601:timestamp} %{NOTSPACE:elb_name} %{IP:client_ip}:%{INT:client_port} %{IP:backend_ip}:%{INT:backend_port} %{NUMBER:request_processing_time} %{NUMBER:backend_processing_time} %{NUMBER:response_processing_time} %{INT:status_code} %{INT:backend_status_code} %{INT:received_bytes} %{INT:sent_bytes} \"%{WORD:http_method} %{URIPATHPARAM:uri_path} HTTP/%{NUMBER:http_version}\" \"%{DATA:user_agent}\" %{NOTSPACE:ssl_cipher} %{NOTSPACE:ssl_protocol}",
			Priority:    101,
			Description: "AWS Elastic Load Balancer Log Format",
			Type:        "standard",
			// Example: 2023-01-23T14:05:01.123456Z my-elb 192.168.0.1:12345 10.0.0.1:80 0.000123 0.001234 0.000012 200 200 1234 5678 "GET /index.html HTTP/1.1" "Mozilla/5.0" ECDHE-RSA-AES128-GCM-SHA256 TLSv1.2
		},

		// AWS Logs
		{
			Name:        "AWS S3 Access Log",
			Pattern:     "%{WORD:bucket_owner} %{NOTSPACE:bucket} \\[%{HTTPDATE:timestamp}\\] (?:-|%{IP:client_ip}) (?:-|%{NOTSPACE:requester}) %{NOTSPACE:request_id} %{NOTSPACE:operation} (?:-|%{NOTSPACE:key}) (?:-|\"%{DATA:request_uri}\") (?:-|%{INT:http_status}) (?:-|%{NOTSPACE:error_code}) (?:-|%{INT:bytes_sent}) (?:-|%{INT:object_size}) (?:-|%{INT:total_time}) (?:-|%{INT:turn_around_time}) \"(?:-|%{DATA:referrer})\" \"(?:-|%{DATA:user_agent})\" (?:-|%{NOTSPACE:version_id})",
			Priority:    110,
			Description: "AWS S3 Access Log Format",
			Type:        "cloud",
			// Example: 79a59df900b949e55d96a1e698fbacedfd6e09d98eacf8f8d5218e7cd47ef2be mybucket [23/Jan/2023:14:05:01 +0000] 192.168.0.1 arn:aws:iam::123456789012:user/user1 ABCDEF1234567890 REST.GET.OBJECT my/object.jpg "GET /my/object.jpg HTTP/1.1" 200 - 4096 4096 1234 1234 "-" "aws-cli/1.16.245 Python/3.6.8 Darwin/18.7.0 botocore/1.12.235" -
		},
		{
			Name:        "AWS CloudFront Log",
			Pattern:     "(?<timestamp>%{YEAR}-%{MONTHNUM}-%{MONTHDAY}\\t%{TIME})\\t%{WORD:edge_location}\\t(?:-|%{INT:bytes_sent})\\t%{IPORHOST:client_ip}\\t%{WORD:http_method}\\t%{HOSTNAME:domain}\\t%{NOTSPACE:uri_path}\\t(?:(?:000)|%{INT:http_status})\\t(?:-|%{DATA:referrer})\\t%{DATA:user_agent}\\t(?:-|%{DATA:query_string})\\t(?:-|%{DATA:cookie})\\t%{WORD:edge_result_type}\\t%{NOTSPACE:request_id}\\t%{HOSTNAME:host}\\t%{WORD:protocol}\\t(?:-|%{INT:bytes_received})\\t%{NUMBER:time_taken}\\t(?:-|%{IP:forwarded_for})\\t(?:-|%{DATA:ssl_protocol})\\t(?:-|%{NOTSPACE:ssl_cipher})\\t%{WORD:edge_response_result_type}",
			Priority:    111,
			Description: "AWS CloudFront Log Format",
			Type:        "cloud",
			// Example: 2023-01-23	14:05:01	LHR62-C2	1234	192.168.0.1	GET	example.com	/index.html	200	-	Mozilla/5.0	-	-	Hit	c1234abc-def5-67gh-89ij-klmno0123456	example.com	https	-	0.001	-	TLSv1.2	ECDHE-RSA-AES128-GCM-SHA256	Hit
		},
		{
			Name:        "AWS CloudTrail Log",
			Pattern:     "%{TIMESTAMP_ISO8601:timestamp} %{NOTSPACE:logger} \\[%{DATA:thread}\\] %{LOGLEVEL:level} %{JAVACLASS:class} - %{GREEDYDATA:message}",
			Priority:    112,
			Description: "AWS CloudTrail Log Format",
			Type:        "cloud",
			CustomPatterns: map[string]string{
				"JAVACLASS": "(?:[A-Za-z0-9-]+\\.)*[A-Za-z0-9-$]+",
			},
			// Example: 2023-01-23T14:05:01.123Z com.amazon.cloudtrail [main] INFO com.amazon.cloudtrail.CloudTrail - AWS API call from user admin to service ec2
		},
		{
			Name:        "AWS CloudWatch Log",
			Pattern:     "%{TIMESTAMP_ISO8601:timestamp} %{GREEDYDATA:message}",
			Priority:    113,
			Description: "AWS CloudWatch Log Format",
			Type:        "cloud",
			// Example: 2023-01-23T14:05:01.123Z Function execution started
		},
		{
			Name:        "Azure Activity Log",
			Pattern:     "%{TIMESTAMP_ISO8601:timestamp} %{WORD:level} %{NOTSPACE:resource_id} %{WORD:operation_name} %{GREEDYDATA:message}",
			Priority:    114,
			Description: "Azure Activity Log Format",
			Type:        "cloud",
			// Example: 2023-01-23T14:05:01.123Z INFO /subscriptions/12345abc-def6-78gh-90ij-klmno123456/resourceGroups/myResourceGroup/providers/Microsoft.Compute/virtualMachines/myVM write VM created successfully
		},
		{
			Name:        "GCP Cloud Logging",
			Pattern:     "%{TIMESTAMP_ISO8601:timestamp} %{LOGLEVEL:severity} %{DATA:project_id} %{DATA:log_id} %{GREEDYDATA:message}",
			Priority:    115,
			Description: "Google Cloud Platform Logging Format",
			Type:        "cloud",
			// Example: 2023-01-23T14:05:01.123Z INFO my-project-id my-log-id Function execution started
		},
		{
			Name:        "Google Cloud Run",
			Pattern:     "%{TIMESTAMP_ISO8601:timestamp} %{LOGLEVEL:severity} %{DATA:project_id} %{DATA:service_name} %{DATA:revision} %{DATA:trace_id} %{GREEDYDATA:message}",
			Priority:    116,
			Description: "Google Cloud Run Log Format",
			Type:        "cloud",
			// Example: 2023-01-23T14:05:01.123Z INFO my-project-id my-service revision-001 projects/my-project/traces/abc123 Request processed successfully
		},
		{
			Name:        "Azure App Service",
			Pattern:     "%{TIMESTAMP_ISO8601:timestamp} %{WORD:app_name} %{LOGLEVEL:level} %{DATA:instance_id} %{GREEDYDATA:message}",
			Priority:    117,
			Description: "Azure App Service Log Format",
			Type:        "cloud",
			// Example: 2023-01-23T14:05:01.123Z myapp INFO instance-0001 Application started
		},

		// Caching and CDN Logs
		{
			Name:        "Varnish Cache Log",
			Pattern:     "%{TIMESTAMP_ISO8601:timestamp} %{SYSLOGHOST:hostname} varnishd\\[%{POSINT:pid}\\]: %{GREEDYDATA:message}",
			Priority:    120,
			Description: "Varnish Cache Log Format",
			Type:        "standard",
			// Example: 2023-01-23T14:05:01.123Z myhost varnishd[1234]: Request handling started
		},
		{
			Name:        "Cloudflare Log",
			Pattern:     "%{IP:client_ip} - %{USERNAME:user} \\[%{HTTPDATE:timestamp}\\] \"%{WORD:method} %{URIPATH:uri_path} HTTP/%{NUMBER:http_version}\" %{NUMBER:status_code} %{NUMBER:bytes} \"%{DATA:referrer}\" \"%{DATA:user_agent}\" %{UUID:ray_id}",
			Priority:    121,
			Description: "Cloudflare CDN Log Format",
			Type:        "standard",
			CustomPatterns: map[string]string{
				"USERNAME": "[a-zA-Z0-9._-]+",
				"UUID":     "[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}",
			},
			// Example: 192.168.0.1 - - [23/Jan/2023:14:05:01 +0000] "GET /index.html HTTP/1.1" 200 1234 "https://example.com" "Mozilla/5.0" c1234abc-def5-67gh-89ij-klmno0123456
		},

		// Application Performance Monitoring
		{
			Name:        "New Relic Log",
			Pattern:     "%{TIMESTAMP_ISO8601:timestamp} %{LOGLEVEL:level}: %{GREEDYDATA:message}",
			Priority:    130,
			Description: "New Relic APM Log Format",
			Type:        "standard",
			// Example: 2023-01-23T14:05:01.123Z INFO: Starting New Relic Agent
		},
		{
			Name:        "Datadog Agent Log",
			Pattern:     "%{TIMESTAMP_ISO8601:timestamp} %{WORD:level} \\| %{WORD:service} \\| %{GREEDYDATA:message}",
			Priority:    131,
			Description: "Datadog Agent Log Format",
			Type:        "standard",
			// Example: 2023-01-23T14:05:01.123Z INFO | datadog-agent | Starting agent
		},

		// CI/CD Logs
		{
			Name:        "Jenkins Build Log",
			Pattern:     "%{TIMESTAMP_ISO8601:timestamp} %{LOGLEVEL:level} %{GREEDYDATA:message}",
			Priority:    140,
			Description: "Jenkins CI/CD Build Log Format",
			Type:        "standard",
			// Example: 2023-01-23T14:05:01.123Z INFO Build #123 started
		},
		{
			Name:        "GitHub Actions Log",
			Pattern:     "%{TIMESTAMP_ISO8601:timestamp} %{WORD:workflow} %{WORD:job} %{GREEDYDATA:message}",
			Priority:    141,
			Description: "GitHub Actions Log Format",
			Type:        "standard",
			// Example: 2023-01-23T14:05:01.123Z build test Running tests...
		},

		// Mail Server Logs
		{
			Name:        "Postfix Log",
			Pattern:     "%{SYSLOGTIMESTAMP:timestamp} %{HOSTNAME:hostname} postfix/%{WORD:process}\\[%{POSINT:pid}\\]: %{POSTFIX_QUEUEID:queue_id}:? %{GREEDYDATA:message}",
			Priority:    150,
			Description: "Postfix Mail Server Log Format",
			Type:        "standard",
			CustomPatterns: map[string]string{
				"POSTFIX_QUEUEID": "([0-9A-F]{6,}|NOQUEUE)",
			},
			// Example: Jan 23 14:05:01 myhost postfix/smtpd[1234]: ABCDEF123456: client=unknown[192.168.0.1], sasl_method=LOGIN, sasl_username=user@example.com
		},
		{
			Name:        "Sendmail Log",
			Pattern:     "%{SYSLOGTIMESTAMP:timestamp} %{HOSTNAME:hostname} sendmail\\[%{POSINT:pid}\\]: %{GREEDYDATA:message}",
			Priority:    151,
			Description: "Sendmail Mail Server Log Format",
			Type:        "standard",
			// Example: Jan 23 14:05:01 myhost sendmail[1234]: Mail from user@example.com accepted
		},

		// File Storage Logs
		{
			Name:        "NFS Log",
			Pattern:     "%{SYSLOGTIMESTAMP:timestamp} %{HOSTNAME:hostname} %{WORD:program}\\[%{POSINT:pid}\\]: %{GREEDYDATA:message}",
			Priority:    160,
			Description: "Network File System (NFS) Log Format",
			Type:        "standard",
			// Example: Jan 23 14:05:01 myhost nfsd[1234]: nfsd_dispatch: vers 3, proc 0, auth 0
		},
		{
			Name:        "SMB Log",
			Pattern:     "%{SYSLOGTIMESTAMP:timestamp} %{HOSTNAME:hostname} %{WORD:program}\\[%{POSINT:pid}\\]: %{GREEDYDATA:message}",
			Priority:    161,
			Description: "Server Message Block (SMB) Log Format",
			Type:        "standard",
			// Example: Jan 23 14:05:01 myhost smbd[1234]: Connection request from 192.168.0.1
		},

		// Blockchain and Cryptocurrency
		{
			Name:        "Ethereum Node Log",
			Pattern:     "%{TIMESTAMP_ISO8601:timestamp}\\s+%{LOGLEVEL:level}\\s+\\[%{DATA:module}\\]\\s+%{GREEDYDATA:message}",
			Priority:    185,
			Description: "Ethereum Node Log Format",
			Type:        "blockchain",
			// Example: 2023-01-23T14:05:01.123Z INFO [eth] Starting synchronization with the network
		},
		{
			Name:        "Bitcoin Core Log",
			Pattern:     "%{TIMESTAMP_ISO8601:timestamp} %{LOGLEVEL:level} %{GREEDYDATA:message}",
			Priority:    186,
			Description: "Bitcoin Core Node Log Format",
			Type:        "blockchain",
			// Example: 2023-01-23T14:05:01.123Z INFO Block height=123456 hash=0000...1234
		},
		{
			Name:        "Hyperledger Fabric Log",
			Pattern:     "%{TIMESTAMP_ISO8601:timestamp} %{LOGLEVEL:level} %{DATA:peer} \\[%{DATA:chaincode}\\] %{GREEDYDATA:message}",
			Priority:    187,
			Description: "Hyperledger Fabric Blockchain Log Format",
			Type:        "blockchain",
			// Example: 2023-01-23T14:05:01.123Z INFO peer0.org1 [chaincode1] Chaincode invocation successful
		},

		// Infrastructure as Code and Configuration Management
		{
			Name:        "Terraform Log",
			Pattern:     "%{TIMESTAMP_ISO8601:timestamp} \\[%{LOGLEVEL:level}\\] %{GREEDYDATA:message}",
			Priority:    188,
			Description: "Terraform IaC Log Format",
			Type:        "infrastructure",
			// Example: 2023-01-23T14:05:01.123Z [INFO] Terraform initialize...
		},
		{
			Name:        "Ansible Log",
			Pattern:     "%{DATA:task}\\s+\\[%{DATA:host}\\]\\s+\\(%{WORD:status}\\)\\:\\s+%{GREEDYDATA:message}",
			Priority:    189,
			Description: "Ansible Configuration Management Log Format",
			Type:        "infrastructure",
			// Example: TASK [Install packages] [server1] (ok): package nginx is installed
		},
		{
			Name:        "Puppet Log",
			Pattern:     "%{TIMESTAMP_ISO8601:timestamp} %{LOGLEVEL:level} %{DATA:source} %{GREEDYDATA:message}",
			Priority:    190,
			Description: "Puppet Configuration Management Log Format",
			Type:        "infrastructure",
			// Example: 2023-01-23T14:05:01.123Z INFO Puppet Agent Applying configuration version '1234567890'
		},
		{
			Name:        "Chef Log",
			Pattern:     "\\[%{TIMESTAMP_ISO8601:timestamp}\\] %{LOGLEVEL:level}: %{GREEDYDATA:message}",
			Priority:    191,
			Description: "Chef Configuration Management Log Format",
			Type:        "infrastructure",
			// Example: [2023-01-23T14:05:01.123Z] INFO: Chef Run complete in 30.001 seconds
		},

		// Streaming and Messaging
		{
			Name:        "Apache Kafka Connect Log",
			Pattern:     "\\[%{TIMESTAMP_ISO8601:timestamp}\\] %{LOGLEVEL:level} %{GREEDYDATA:message} \\(%{JAVACLASS:class}\\)",
			Priority:    192,
			Description: "Apache Kafka Connect Log Format",
			Type:        "streaming",
			CustomPatterns: map[string]string{
				"JAVACLASS": "(?:[A-Za-z0-9-]+\\.)*[A-Za-z0-9-$]+",
			},
			// Example: [2023-01-23T14:05:01.123Z] INFO Worker started (org.apache.kafka.connect.cli.ConnectDistributed)
		},
		{
			Name:        "Apache Pulsar Log",
			Pattern:     "%{TIMESTAMP_ISO8601:timestamp} \\[%{DATA:thread}\\] %{LOGLEVEL:level} %{JAVACLASS:class} - %{GREEDYDATA:message}",
			Priority:    193,
			Description: "Apache Pulsar Messaging Log Format",
			Type:        "streaming",
			CustomPatterns: map[string]string{
				"JAVACLASS": "(?:[A-Za-z0-9-]+\\.)*[A-Za-z0-9-$]+",
			},
			// Example: 2023-01-23T14:05:01.123Z [pulsar-io-kafka-connect-0] INFO org.apache.pulsar.io.kafka.KafkaSinkConnector - Starting connector
		},
		{
			Name:        "NATS Server Log",
			Pattern:     "\\[%{NUMBER:timestamp}\\] \\[%{LOGLEVEL:level}\\] %{GREEDYDATA:message}",
			Priority:    194,
			Description: "NATS Messaging Server Log Format",
			Type:        "streaming",
			// Example: [12345] [INF] Server is ready
		},

		// Default Enhanced Catchall Patterns
		{
			Name:        "Generic Timestamped Log",
			Pattern:     "%{TIMESTAMP_ISO8601:timestamp} %{LOGLEVEL:level} %{GREEDYDATA:message}",
			Priority:    200,
			Description: "Generic timestamp + level + message pattern",
			Type:        "standard",
			// Example: 2023-01-23T14:05:01.123Z INFO This is a generic log message
		},
		{
			Name:        "Generic Structured Log",
			Pattern:     "(?:%{TIMESTAMP_ISO8601:timestamp})?\\s*\\{.*\"level\":\\s*\"%{LOGLEVEL:level}\".*\"message\":\\s*\"%{DATA:message}\".*\\}",
			Priority:    201,
			Description: "Generic JSON structured log pattern",
			Type:        "standard",
			// Example: {"timestamp":"2023-01-23T14:05:01.123Z","level":"info","message":"Application started","service":"api"}
		},
		{
			Name:        "Syslog Timestamped",
			Pattern:     "%{SYSLOGTIMESTAMP:timestamp} %{GREEDYDATA:message}",
			Priority:    202,
			Description: "Basic syslog timestamp + message pattern",
			Type:        "standard",
			// Example: Jan 23 14:05:01 This is a generic syslog message
		},
		{
			Name:        "Basic Line with Timestamp",
			Pattern:     "\\[?%{TIMESTAMP_ISO8601:timestamp}\\]?\\s+%{GREEDYDATA:message}",
			Priority:    210,
			Description: "Basic line with ISO8601 timestamp pattern",
			Type:        "standard",
			// Example: [2023-01-23T14:05:01.123Z] This is a message with timestamp
		},
	}
}
