# Sample Log Files

Ready-to-import log files for testing logsonic. Files from [logpai/loghub](https://github.com/logpai/loghub) are real production logs; synthetic files are realistic generated samples.

## Files

| File | Lines | Source | Format Example |
|------|-------|--------|----------------|
| `apache.log` | ~2000 | loghub | `[Sun Dec 04 04:47:44 2005] [notice] message` |
| `openssh.log` | ~2000 | loghub | `Dec 10 06:55:46 LabSZ sshd[24200]: message` |
| `linux-syslog.log` | ~2000 | loghub | `Jun 14 15:16:01 combo sshd(pam_unix)[19939]: message` |
| `mac-system.log` | ~2000 | loghub | `Jul  2 00:01:03 username process[pid]: message` |
| `hadoop.log` | ~2000 | loghub | `2015-10-18 18:01:15,966 INFO ... message` |
| `hdfs.log` | ~2000 | loghub | `081109 203518 BLOCK* ... message` |
| `spark.log` | ~2000 | loghub | `15/10/17 15:26:18 INFO SparkContext: message` |
| `zookeeper.log` | ~2000 | loghub | `2015-07-29 21:19:51,541 - INFO [thread:Class@hex] message` |
| `openstack.log` | ~2000 | loghub | `2015-10-21 00:19:32.613 ... INFO nova.compute message` |
| `bgl-supercomputer.log` | ~2000 | loghub | `- 1117838570 2005.06.03 ... RAS KERNEL INFO message` |
| `hpc.log` | ~2000 | loghub | `LogBase 1 1 8 2 25 3 0 2 2 3 1` |
| `healthapp.log` | ~2000 | loghub | `07-26 15:57:47:817 pid HealthApp module:msg\|key=val` |
| `nginx-access.log` | 500 | synthetic | `192.168.1.10 - - [01/Apr/2026:00:00:00 +0000] "GET /api HTTP/1.1" 200 1234 "-" "curl/7.68.0"` |
| `app-json.log` | 500 | synthetic | `{"timestamp":"2026-04-01T00:00:00+00:00","level":"INFO","service":"api","message":"..."}` |
| `postgresql.log` | 400 | synthetic | `2026-04-01 00:00:00.123 UTC [12345] app_user@logsonic LOG: statement: SELECT ...` |
| `docker.log` | 400 | synthetic | `2026-04-01T00:00:00.000Z  a1b2c3d4e5f6  logsonic-api  Starting server on :8080` |
