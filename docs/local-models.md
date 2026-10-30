# Run the agent on a local model (LFM3 with Ollama)

The agent can run on a model on your own computer instead of a cloud API.
Your logs then never leave the machine, and you need no API key. This guide
uses [Ollama](https://ollama.com) and Liquid AI's
[LFM3](https://ollama.com/library/lfm3) 1.7B model: a 1.2 GB download that
supports tool calls and runs on a laptop. The same steps work for any Ollama
model whose `ollama show` output lists `tools`.

Tested on 2026-10-30 with Ollama 0.40.13 on macOS (Apple silicon) and Ubuntu
26.04 (NVIDIA RTX 4090).

## What to expect

A 1.7B model is good at the routine part of an investigation: importing a file
you name, searching, counting by field, and putting the evidence in the log
table. It is weaker at reasoning over many results. In our tests it once
reported three errors where the table showed two, and it described viewer
settings that did not exist. Check its claims against the rows it shows in the
table. For open-ended investigations, use a larger model.

One agent turn (import a file, search it, summarize, show the evidence) took:

| Machine | Time |
| --- | --- |
| Mac, Apple silicon, model on GPU | 12 to 14 s |
| Linux, RTX 4090, model on GPU | 13 s |
| Linux, model on CPU (GPU memory full) | about 80 s |

## 1. Install Ollama

- **macOS**: install the app from [ollama.com/download](https://ollama.com/download),
  or run `brew install ollama` and then `ollama serve` (or
  `brew services start ollama` to start it at login).
- **Linux**: `curl -fsSL https://ollama.com/install.sh | sh`. This installs
  Ollama as a systemd service on port 11434.
- **Windows**: run the installer from [ollama.com/download](https://ollama.com/download).

LFM3 needs a recent Ollama. An older version (we saw this with 0.6.2) refuses
the download and ends with "Please download the latest version at:
https://ollama.com/download". Install the current version over it; your other
models are kept.

## 2. Download the model

```sh
ollama pull lfm3:1.7b
ollama show lfm3:1.7b
```

Under **Capabilities**, the output must list `tools`.

## 3. Give the model enough context

Each agent request carries the instructions, the tool definitions and the tool
results so far: about 10,000 to 15,000 tokens. Ollama sizes its default context
window from your GPU memory, and on a machine with little memory it can be as
small as 4,096 tokens. The request is then cut short and the agent misbehaves.

Create a copy of the model with a 32,768-token window:

```sh
printf 'FROM lfm3:1.7b\nPARAMETER num_ctx 32768\n' > Modelfile
ollama create lfm3-logsonic -f Modelfile
```

On Windows (PowerShell):

```powershell
"FROM lfm3:1.7b`nPARAMETER num_ctx 32768" | Out-File -Encoding ascii Modelfile
ollama create lfm3-logsonic -f Modelfile
```

After the first agent request, `ollama ps` shows `32768` under **CONTEXT**
(on Linux the row may carry the base name `lfm3:1.7b`), and **PROCESSOR** shows
whether the model runs on the GPU.

## 4. Connect LogSonic

In **Settings > Agent** (the gear in the agent dock):

1. Under **API format**, choose **OpenAI compatible**.
2. Under **Endpoint URL**, click the Ollama example,
   `http://localhost:11434/v1/chat/completions`.
3. Next to **Model**, click the refresh button and pick `lfm3-logsonic`.
4. Leave **API key** empty. Ollama does not need one.
5. Click **Test**. It should say "Works: lfm3-logsonic at localhost:11434
   answered in … ms".
6. Click **Save**.

Or set the same values as environment variables before starting LogSonic.
Environment variables win over saved settings.

```sh
export LOGSONIC_AGENT_PROVIDER=openai
export LOGSONIC_AGENT_PROXY_URL=http://localhost:11434/v1/chat/completions
export LOGSONIC_AGENT_MODEL=lfm3-logsonic
logsonic
```

On Windows (PowerShell):

```powershell
$env:LOGSONIC_AGENT_PROVIDER = "openai"
$env:LOGSONIC_AGENT_PROXY_URL = "http://localhost:11434/v1/chat/completions"
$env:LOGSONIC_AGENT_MODEL = "lfm3-logsonic"
logsonic
```

Ollama also serves the Anthropic format. If you prefer it, choose
**Anthropic** and use `http://localhost:11434/v1/messages`.

## 5. Try it

Open the agent dock (**Agent** in the top bar) and ask, for example:

> Import ~/logs/app.log and summarize the errors.

The model name shows next to the investigation title. An import of a path you
named runs straight away. If the model picks a path or URL you did not write,
LogSonic asks you first; see [Agent security](agent-security.md).

## Ollama on another computer

Use this when a desktop with a GPU should serve a laptop. LogSonic accepts
plain `http://` endpoints only on localhost, so forward the port over SSH
instead of opening Ollama to the network:

```sh
ssh -N -L 11434:127.0.0.1:11434 you@gpu-box
```

Keep that running and use `http://localhost:11434/v1/chat/completions` as
above. A remote `http://` address fails with "plain HTTP model endpoints must
be on localhost; use HTTPS for a remote endpoint".

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `ollama pull` asks you to download the latest version | Update Ollama (step 1). |
| **Test** reports connection refused | Ollama is not running. Start it with `ollama serve`, the Ollama app, or `sudo systemctl start ollama` on Linux. |
| The model list is empty | Run `ollama pull lfm3:1.7b`, then click the refresh button again. |
| The agent answers without calling tools, or forgets the question | The context window is too small (step 3), or the model lacks `tools` in `ollama show`. |
| Answers are very slow | `ollama ps` shows the model on CPU. Free GPU memory (close other GPU programs) or use a smaller model. |
