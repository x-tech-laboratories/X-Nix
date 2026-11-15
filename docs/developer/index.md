---
title: Developer guide
---

This guide is for people who change X-Nix itself. It explains how the code is laid out, how the server, the agents and
the page talk to each other, what the database holds, and how each long-running process moves from state to state. How
to install and use X-Nix is in the [user guide](/user/).

X-Nix follows the X-Tech [Application Standard](https://x-tech-laboratories.github.io/standards/application/) and the
[Design Guidelines](https://x-tech-laboratories.github.io/standards/design/): TypeScript run directly by Node 24,
Fastify on the server, React on the page, SQLite through `node:sqlite`, shared server pieces, agent plumbing and widgets
from [X-Libs](https://github.com/x-tech-laboratories/X-Libs), and styling from Halon. Read both standards before changing
anything.

| Page                                         | What it covers                                                        |
| -------------------------------------------- | --------------------------------------------------------------------- |
| [Architecture](/developer/architecture/)     | The processes, the components inside the server, and the design rules. |
| [Module hierarchy](/developer/modules/)      | Every source module, its layer, what it imports, and what comes from X-Libs. |
| [Data model](/developer/data-model/)         | The SQLite tables as an ERD, and the JSON documents stored in them.   |
| [Flows](/developer/flows/)                   | Flow charts, sequence diagrams and state machines for every long process. |
| [Agent protocol](/developer/agent-protocol/) | How agents connect and log in, long runs, and every operation.        |
| [HTTP API](/developer/api/)                  | Every route, who may call it, the change feed and MCP.                |
| [Development](/developer/development/)       | Setting up, running, testing, packaging, and how to add features.     |

The diagrams are written in [Mermaid](https://mermaid.js.org/), which GitHub draws when it shows these files.
