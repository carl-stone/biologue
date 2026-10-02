# Biologue architecture

Biologue is a scientific workbench where a scientist and agents work with the
same project files, live R and Python sessions, and recorded evidence. This
document defines the architecture of the intended product and marks which parts
are implemented. The diagrams are the primary map; each numbered area in the
overview has a matching zoom view below.

Update this document when an architectural boundary, ownership rule, or committed
capability changes. Routine features, dependency versions, tuning, and release
history belong in other documents. Setup, checks, and operational details live in
[development](docs/development.md).

## Reading the diagrams

**Solid boxes and arrows describe implemented responsibilities and connections.**
**Orange boxes with dashed borders and the word PLANNED describe committed parts
that are not implemented.** Connections involving those parts are dashed too.
Planned additions inside an existing area are shown separately from its working
core. Color otherwise identifies ownership: teal for the workbench, blue for
Biologue services, purple for Pi and model interaction, green for scientific
runtimes, and gray for storage.

Arrows show requests, data, or results. A box is a responsibility, not necessarily
a separate operating-system process. Biologue services initially remain modules
in one Node application; Jupyter and its kernels run separately.

## Overview

```mermaid
%%{init: {"theme":"base","htmlLabels":false,"markdownAutoWrap":false,"themeVariables":{"fontFamily":"Arial, sans-serif","lineColor":"#475569","edgeLabelBackground":"#FFFFFF"},"flowchart":{"htmlLabels":false,"curve":"linear","nodeSpacing":30,"rankSpacing":40,"wrappingWidth":240,"minNodeWidth":200}}}%%
flowchart TB
    Workbench["1 · Workbench and project<br/>Chat · code · scientist's context"]
    Agents["2 · Agents and workflows<br/>Run supervision · Pi Durable conversations"]
    Execution["3 · Shared R/Python execution<br/>Recorded code · queues"]
    Evidence["4 · Evidence and persistence<br/>History · source · captured outputs"]
    Models["Model providers"]
    Runtime["Jupyter<br/>Separate Python and R kernels"]
    Multi["PLANNED<br/>Child tasks and workflow coordination"]

    Workbench -->|"Ask, steer, stop"| Agents
    Workbench -->|"Run or inspect"| Execution
    Agents -->|"Authorized code and inspection"| Execution
    Agents <--> Models
    Execution <--> Runtime
    Execution -->|"Source and captured results"| Evidence
    Workbench <--> Evidence
    Agents <--> Evidence
    Multi -.-> Agents

    classDef workbench fill:#E6FFFB,stroke:#0F766E,color:#134E4A
    classDef app fill:#EFF6FF,stroke:#2563EB,color:#172554
    classDef pi fill:#F5F3FF,stroke:#7C3AED,color:#3B0764
    classDef runtime fill:#F0FDF4,stroke:#15803D,color:#14532D
    classDef storage fill:#F1F5F9,stroke:#64748B,color:#1E293B
    classDef planned fill:#FFF7ED,stroke:#C2410C,color:#7C2D12,stroke-width:2px,stroke-dasharray:6 4
    class Workbench workbench
    class Agents,Execution app
    class Models pi
    class Runtime runtime
    class Evidence storage
    class Multi planned
```

The workbench, agents, and workflows all operate on the same project. Agent
conversations have separate histories, while files and scientific sessions stay
shared within that project. Different projects have separate workspace state and
scientific sessions.

## 1. Workbench and project

The workbench is a React interface using Dockview for panels and CodeMirror for
editing. The same interface works in a browser or a Tauri desktop shell. Its
application API carries requests, paged results, and live updates.

```mermaid
%%{init: {"theme":"base","htmlLabels":false,"markdownAutoWrap":false,"themeVariables":{"fontFamily":"Arial, sans-serif","lineColor":"#475569","edgeLabelBackground":"#FFFFFF"},"flowchart":{"htmlLabels":false,"curve":"linear","nodeSpacing":30,"rankSpacing":40,"wrappingWidth":240,"minNodeWidth":200}}}%%
flowchart TB
    UI["Scientist's workbench<br/>Chat · editor · console<br/>Objects · plots · tables"]
    API["Application API and event stream"]
    Tools["2 · Authorized agent tools"]
    Documents["Document service<br/>Shared working buffers<br/>Versioned edits"]
    Notes["Context service<br/>Scientist-authored notes<br/>Version history"]
    Attachments["Attachment snapshots<br/>Text · images · source revisions"]
    Files[("4 · Project files")]
    Agents["2 · Agent supervision"]
    Knowledge["PLANNED<br/>Structured scientific claims<br/>and source links"]
    Desktop["PLANNED<br/>Desktop runtime packaging"]

    UI <-->|"Requests and updates"| API
    API <--> Documents
    Tools <-->|"Read and edit buffers"| Documents
    Documents <-->|"Save and reconcile"| Files
    API <--> Notes
    Notes -->|"Context snapshot"| Agents
    API --> Attachments
    Attachments -->|"Selected message attachments"| Agents
    Knowledge -.-> Notes
    Desktop -.->|"Launch workbench and local services"| UI

    classDef workbench fill:#E6FFFB,stroke:#0F766E,color:#134E4A
    classDef app fill:#EFF6FF,stroke:#2563EB,color:#172554
    classDef storage fill:#F1F5F9,stroke:#64748B,color:#1E293B
    classDef planned fill:#FFF7ED,stroke:#C2410C,color:#7C2D12,stroke-width:2px,stroke-dasharray:6 4
    class UI workbench
    class API,Tools,Documents,Notes,Attachments,Agents app
    class Files storage
    class Knowledge,Desktop planned
```

The editor keeps a responsive local copy and recovery journal. Acknowledged
server revisions are the shared document authority, including unsaved edits.
Saving writes to disk; file watching and reconciliation expose conflicts for
review. Creating files, Save As, and attachment snapshots are implemented.

Scientist-authored notes have their own version history. Each model request
receives the current notes, including when an interrupted request resumes;
scientist corrections also remain in conversation history. Structured claims and source links
extend this context boundary, but currently the notes are text.

The desktop shell exists. Bundling and launching the application server and
scientific runtime as an installed desktop product remain planned. Today the
development launcher manages the local services. Browser access uses those same
services, with the application API listening locally by default.

## 2. Agents and workflows

Pi Durable owns the model loop, task checkpoints, input admission, recovery,
and canonical conversation history. Biologue supplies authorization, project
context, browser projections, and connections to the shared project. Future delegation and workflows use native Durable tasks and conversations.

```mermaid
%%{init: {"theme":"base","htmlLabels":false,"markdownAutoWrap":false,"themeVariables":{"fontFamily":"Arial, sans-serif","lineColor":"#475569","edgeLabelBackground":"#FFFFFF"},"flowchart":{"htmlLabels":false,"curve":"linear","nodeSpacing":30,"rankSpacing":40,"wrappingWidth":240,"minNodeWidth":200}}}%%
flowchart TB
    UI["1 · Conversation input<br/>Start · steer · stop"]
    Workflow["PLANNED<br/>Workflow supervisor<br/>Dependencies · scientist review"]
    Delegate["PLANNED<br/>Pi agent delegation tools"]
    subgraph Runs["Workbench integration"]
        Lifecycle["Workbench bridge<br/>Pending input · progress<br/>Displayed outcomes"]
        Tasks["PLANNED<br/>Delegation and workflows<br/>Integrate native tasks"]
    end
    Context["1 · Selected context<br/>Notes · instructions · skills"]
    Pi["Pi Durable Harness<br/>Tasks · recovery · tools<br/>Retries · compaction"]
    Models["Model providers"]
    Tools["Authorized tools<br/>Workspace · MCP<br/>Questions · orchestration"]
    Project["1 · Shared project workspace"]
    Execution["3 · Shared R/Python execution"]
    Evidence["4 · History and evidence"]

    UI --> Lifecycle
    Workflow <-.->|"Launch · await · cancel"| Tasks
    Delegate <-.->|"Same task interface"| Tasks
    Tasks -.-> Pi
    Lifecycle -->|"Submit, steer, abort tasks"| Pi
    Context --> Pi
    Pi <--> Models
    Pi --> Tools
    Tools <--> Project
    Tools --> Execution
    Lifecycle --> Evidence
    Pi <--> Evidence

    classDef workbench fill:#E6FFFB,stroke:#0F766E,color:#134E4A
    classDef app fill:#EFF6FF,stroke:#2563EB,color:#172554
    classDef pi fill:#F5F3FF,stroke:#7C3AED,color:#3B0764
    classDef storage fill:#F1F5F9,stroke:#64748B,color:#1E293B
    classDef planned fill:#FFF7ED,stroke:#C2410C,color:#7C2D12,stroke-width:2px,stroke-dasharray:6 4
    class UI workbench
    class Lifecycle,Context,Tools,Project,Execution app
    class Pi,Models pi
    class Evidence storage
    class Workflow,Delegate,Tasks planned
    style Runs fill:#F8FAFC,stroke:#64748B,color:#1E293B
```

Run supervision, steering, cancellation, pending input metadata, permissions,
and Pi Durable conversations are implemented. Supervisor restores project context
and tool definitions for every active run before enabling scheduling.
Pi Durable owns task lifetimes and nested code-mode calls. Delegation and workflow
coordination remain planned; their children will use separate durable conversations
and the same Biologue services. Pi resources, MCP, questions, and code mode
are connected through native tools and extensions; no AgentSession or second agent loop runs.

Task lifetime, parent/child ownership, and cancellation belong to Pi Durable.
Future delegation and workflows should compose its tasks and conversations,
keeping their application state in native documents. They do not require an
additional lifecycle service or task journal.

Biologue's permission service gates workspace edits and analysis execution
according to the scientist's selected mode. Inspection is recorded and directly
available. MCP tools use the same permission system unless declared read-only.
Connections are shared within a project. Direct tools connect during setup;
other servers connect on discovery or resource access. Code mode uses loaded
tools, so workspace-only scripts leave unused MCP servers stopped. Stopping a
response cancels its calls; project shutdown and configuration changes close
connections.
Pi's built-in shell and file-writing tools are excluded. Code mode orchestrates
tools; it does not supply a second scientific runtime. Child permissions must
stay within their caller's authorization.

Pi loads skills and project instructions and compacts its canonical history.
Pi also manages model-provider configuration and authentication on the
application side.
The default agent is a coding assistant. Project instructions, skills, and
user-authored notes supply domain-specific behavior. Pi Durable provides standard
compaction; Biologue does not impose a scientific summary policy.

## 3. Shared R/Python execution

Every request to execute scientific code or inspect live kernel objects,
including automatic environment refreshes, enters ExecutionService. Human and
agent code use the same persistent session for a language. Python and R have
separate object namespaces.

```mermaid
%%{init: {"theme":"base","htmlLabels":false,"markdownAutoWrap":false,"themeVariables":{"fontFamily":"Arial, sans-serif","lineColor":"#475569","edgeLabelBackground":"#FFFFFF"},"flowchart":{"htmlLabels":false,"curve":"linear","nodeSpacing":30,"rankSpacing":40,"wrappingWidth":240,"minNodeWidth":200}}}%%
flowchart TB
    Human["1 · Human code and inspection"]
    Agent["2 · Authorized agent code and inspection"]
    Refresh["Automatic environment refresh"]
    Execution["ExecutionService<br/>Exact code · one queue per language<br/>Readiness · interrupt · capture results"]
    Client["Jupyter kernel client<br/>Sessions · messages · interrupt"]
    Jupyter["Jupyter Server"]
    Python["Python session · ipykernel<br/>Shared live objects"]
    R["R session · Ark<br/>Shared live objects"]
    Outputs["4 · OutputService<br/>Captured results<br/>Immutable artifacts"]

    Human --> Execution
    Agent --> Execution
    Refresh --> Execution
    Execution <-->|"Code and kernel events"| Client
    Client <--> Jupyter
    Jupyter <--> Python
    Jupyter <--> R
    Execution -->|"Captured outputs"| Outputs

    classDef workbench fill:#E6FFFB,stroke:#0F766E,color:#134E4A
    classDef app fill:#EFF6FF,stroke:#2563EB,color:#172554
    classDef runtime fill:#F0FDF4,stroke:#15803D,color:#14532D
    classDef planned fill:#FFF7ED,stroke:#C2410C,color:#7C2D12,stroke-width:2px,stroke-dasharray:6 4
    class Human workbench
    class Agent,Refresh,Execution,Client,Outputs app
    class Jupyter,Python,R runtime
```

Code and source identity are captured before queuing and remain immutable.
Editing a file later cannot change what an execution record says ran. Language
adapters generate inspection requests and decode results; ExecutionService calls
the kernel client for both ordinary code and those requests.

Execution verifies a referenced working document has not changed, honors
cancellation, and reconciles uncertain kernel state before dispatch. It does not
analyze code dependencies, track what objects the agent has observed, or impose
a mandatory scientific review. Project instructions and skills supply any
domain-specific behavior.

Cancellation and shutdown cover every actor. If kernel completion cannot be
confirmed, the outcome stays uncertain and that language's session must pass a
readiness check before dispatching further execution. Nothing is automatically
replayed. Agents can reason concurrently, but kernel operations remain
serialized within each language's queue.

Execution records include exact source, actor, relevant document revision,
kernel identity, status, and output references. Recorded history does not restore
live R or Python objects.

## 4. Evidence and persistence

Each kind of state has one authority. Pi owns delivered conversation history;
Biologue owns application records; project files and captured outputs remain
independent of any individual agent session.

```mermaid
%%{init: {"theme":"base","htmlLabels":false,"markdownAutoWrap":false,"themeVariables":{"fontFamily":"Arial, sans-serif","lineColor":"#475569","edgeLabelBackground":"#FFFFFF"},"flowchart":{"htmlLabels":false,"curve":"linear","nodeSpacing":30,"rankSpacing":40,"wrappingWidth":240,"minNodeWidth":200}}}%%
flowchart TB
    Documents["1 · Document service"]
    Domain["Biologue services<br/>Context · supervision<br/>Permissions · execution"]
    Pi["2 · Pi Durable Harness"]
    Outputs["OutputService<br/>Captured events and display views"]
    Files[("Project files<br/>Scripts · data · reports")]
    SQLite[("SQLite<br/>Revisions · run display cache<br/>Permissions<br/>Execution source and metadata<br/>Output references")]
    History[("Pi Durable SQLite<br/>History · submissions · pending input<br/>Display metadata · latest run<br/>Task checkpoints · usage")]
    Blobs[("Artifact store<br/>Immutable output payloads<br/>Content hashes")]
    Projection["Rebuildable conversation display index"]
    Chat["1 · Conversation display"]
    Readers["Workbench and agent tools<br/>Exact source and artifacts"]
    Tasks["PLANNED<br/>Durable child-task<br/>and workflow records"]

    Documents <--> Files
    Documents <--> SQLite
    Domain <--> SQLite
    Pi <--> History
    History -->|"History and pending input"| Projection
    Outputs --> SQLite
    Outputs --> Blobs
    Projection -->|"Selected conversation"| Chat
    SQLite -->|"Records and references"| Readers
    Blobs -->|"Exact captured payloads"| Readers
    Tasks -.-> Domain

    classDef workbench fill:#E6FFFB,stroke:#0F766E,color:#134E4A
    classDef app fill:#EFF6FF,stroke:#2563EB,color:#172554
    classDef pi fill:#F5F3FF,stroke:#7C3AED,color:#3B0764
    classDef storage fill:#F1F5F9,stroke:#64748B,color:#1E293B
    classDef planned fill:#FFF7ED,stroke:#C2410C,color:#7C2D12,stroke-width:2px,stroke-dasharray:6 4
    class Documents,Domain,Outputs,Projection app
    class Pi pi
    class Files,SQLite,History,Blobs storage
    class Chat,Readers workbench
    class Tasks planned
```

Accepted user input is recorded before Pi consumes it. Pending native documents
preserve queued inputs across cancellation or restart; the conversation
display is derived from Pi history plus pending inputs. The display index can be
rebuilt without changing canonical history. Conversation branching inherits
a selected history prefix; branches continue using the same project files and live kernels.
Branching, archival, and Markdown conversation export are implemented.

Execution source is stored separately from changing status metadata. OutputService
preserves captured events and immutable payloads, with a separate display view
for plots and tables. A display update points to new content rather than rewriting
historical bytes. Display identities are scoped to a kernel generation, so a
restart cannot silently overwrite an earlier figure. The workbench and agent
tools retrieve the same recorded evidence without rerunning code.

The project state directory holds application SQLite, Pi Durable SQLite, and
artifact blobs; back up the entire directory. There is no legacy-chat import.
Each conversation keeps its latest run state rather than a growing run archive.
Pending input state contains only unsent or queued messages. On delivery, the
original text and attachments move to metadata keyed by the native entry;
expanded content stays in native history. Regular queue and chat reads do not
scan old submission records. The application retains no parallel receipt archive.

Durable owns delivered model content and task history. The durable database uses SQLite
WAL with synchronous FULL and a process ownership record that prevents concurrent
harness writers. Shutdown suspends work; explicit Stop aborts it. On restart,
unfinished model requests can resume, while interrupted kernel tools settle
with unknown effects and are never replayed automatically. Browser questions
retain stable IDs and consume committed answers when safely replayed. Live kernel objects are separate
runtime state. Historical source and captured outputs remain available through
the same execution and artifact services used by the workbench.

## Implementation anchors

These entry points connect the diagrams to the code. They identify ownership,
without prescribing internal class structure or API details.

| View                          | Main implementation anchors                                                                                                                                                                                                                                                                                |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 · Workbench and project     | [Workbench](packages/workbench/src/App.tsx), [API composition](packages/server/src/app.ts), [documents](packages/server/src/documents.ts), [editor synchronization](packages/workbench/src/document-sync.ts), [context](packages/server/src/context.ts), [attachments](packages/server/src/attachments.ts) |
| 2 · Agents and workflows      | [Supervisor](packages/server/src/supervisor.ts), [Pi adapter](packages/server/src/pi.ts), [permissions](packages/server/src/permissions.ts), [workspace tools](packages/server/src/workspace-tools.ts)                                                                                                     |
| 3 · Shared R/Python execution | [ExecutionService](packages/server/src/execution.ts), [kernel client](packages/server/src/kernels.ts), [language adapters](packages/server/src/adapters.ts), [environment refresh](packages/server/src/environment.ts)                                                                                     |
| 4 · Evidence and persistence  | [Conversation sessions](packages/server/src/conversation-sessions.ts), [execution repository](packages/server/src/execution-repository.ts), [outputs](packages/server/src/outputs.ts), [SQLite store](packages/server/src/store.ts)                                                                        |
