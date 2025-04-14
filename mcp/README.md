## MCP Server for Logsonic

This folder contains MCP server for your logsonic installation. MCP server package allows you to interface logsonic with popular MCP clients 
such as Claud Desktop, Cursor, Windsurf. etc. 

In order to install the server, clone the git repository and 

```
cd logsonic/mcp
npm i 
```

Afterwards, add the following MCP configuration to your favorite tool. **Remember** to replace the path with your actual git folder location. 
Change the env variables for LOGSONIC_HOST and LOGSONIC_PORT if you are using non standard values to run your logsonic server. 

```
{
  "mcpServers": {
    
    "logsonic": {
      "command": "npx",
      "args": [
        "tsx",
        "<Replace this with your actual path>/logsonic/mcp/index.ts"
      ],
      "env": {
        "LOGSONIC_HOST": "localhost",
        "LOGSONIC_PORT": "8080"
      }
    }
  }
}
```