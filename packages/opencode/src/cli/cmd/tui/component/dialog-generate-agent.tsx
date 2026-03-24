import { createMemo, createSignal, For, onMount, Show, Switch, Match } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { sortBy } from "remeda"
import { useDialog } from "@tui/ui/dialog"
import { DialogPrompt } from "@tui/ui/dialog-prompt"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useTheme } from "@tui/context/theme"
import { useLocal } from "@tui/context/local"
import { useSync } from "@tui/context/sync"
import { useSDK } from "@tui/context/sdk"
import { useToast } from "@tui/ui/toast"

type Mode = "all" | "primary" | "subagent"
type Action = "allow" | "ask" | "deny"
type Choice = "inherit" | Action | "custom"
type Perm =
  | "read"
  | "edit"
  | "bash"
  | "glob"
  | "grep"
  | "list"
  | "task"
  | "external_directory"
  | "question"
  | "webfetch"
  | "websearch"
  | "codesearch"
  | "lsp"
  | "skill"
  | "todowrite"
  | "todoread"

type Rule = {
  pattern: string
  action: Action
}

type Draft = {
  description: string
  model?: { providerID: string; modelID: string }
  mode: Mode
  permission: Partial<Record<Perm, { choice: Choice; rules: Rule[] }>>
  path: string
  load: boolean
}

type Step =
  | { type: "description" }
  | { type: "model" }
  | { type: "mode" }
  | { type: "permissions" }
  | { type: "permission"; permission: Perm }
  | { type: "rule"; permission: Perm; action: Action }
  | { type: "storage" }
  | { type: "custom_path" }
  | { type: "load" }
  | { type: "review" }

const PERMISSIONS: { id: Perm; title: string; custom: string }[] = [
  { id: "read", title: "Read", custom: "Path or glob pattern" },
  { id: "edit", title: "Edit/Write", custom: "Path or glob pattern" },
  { id: "bash", title: "Bash", custom: "Command or glob-like pattern" },
  { id: "glob", title: "Glob", custom: "Path or glob pattern" },
  { id: "grep", title: "Grep", custom: "Path or glob pattern" },
  { id: "list", title: "List", custom: "Path or glob pattern" },
  { id: "task", title: "Task", custom: "Agent or pattern" },
  { id: "external_directory", title: "External directory", custom: "Path or glob pattern" },
  { id: "question", title: "Question", custom: "Pattern" },
  { id: "webfetch", title: "Webfetch", custom: "URL pattern" },
  { id: "websearch", title: "Websearch", custom: "Pattern" },
  { id: "codesearch", title: "Codesearch", custom: "Pattern" },
  { id: "lsp", title: "LSP", custom: "Path or glob pattern" },
  { id: "skill", title: "Skill", custom: "Skill or pattern" },
  { id: "todowrite", title: "Todo write", custom: "Pattern" },
  { id: "todoread", title: "Todo read", custom: "Pattern" },
]

export function DialogGenerateAgent(props: { sessionID?: string; initialDescription?: string }) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const local = useLocal()
  const sync = useSync()
  const sdk = useSDK()
  const toast = useToast()
  const globalProject = createMemo(() => sync.data.path.worktree === "/")
  const projectPath = createMemo(() => `${sync.data.path.worktree}/.opencode/agent`)
  const globalPath = createMemo(() => `${sync.data.path.config}/agent`)
  const firstModel = createMemo(() => {
    const all = sortBy(sync.data.provider_next.all, (item) => item.name)
    for (const provider of all) {
      const entry = Object.values(provider.models).find((item) => item.status !== "deprecated")
      if (!entry) continue
      return { providerID: provider.id, modelID: entry.id }
    }
  })
  const [draft, setDraft] = createStore<Draft>({
    description: props.initialDescription ?? "",
    model: local.model.current() ?? firstModel(),
    mode: "all",
    permission: {},
    path: globalProject() ? globalPath() : projectPath(),
    load: true,
  })
  const [step, setStep] = createSignal<Step>({ type: "description" })
  const permission = createMemo(() => {
    const result: Record<string, string | Record<string, Action>> = { "*": "deny" }
    for (const item of PERMISSIONS) {
      const state = draft.permission[item.id]
      if (!state || state.choice === "inherit") continue
      if (state.choice === "custom") {
        result[item.id] = Object.fromEntries(state.rules.map((rule) => [rule.pattern, rule.action]))
        continue
      }
      result[item.id] = state.choice
    }
    return result
  })
  const modelTitle = createMemo(() => {
    const model = draft.model
    if (!model) return "No model selected"
    const provider = sync.data.provider_next.all.find((item) => item.id === model.providerID)
    const info = provider?.models[model.modelID]
    return `${provider?.name ?? model.providerID} / ${info?.name ?? model.modelID}`
  })

  async function confirm() {
    const model = draft.model
    if (!model) {
      toast.show({ message: "Select a model first", variant: "warning", duration: 3000 })
      setStep({ type: "model" })
      return
    }
    const result = await sdk.client.agent.create({
      sessionID: props.sessionID,
      agent: local.agent.current().name,
      description: draft.description.trim() || undefined,
      model,
      mode: draft.mode,
      permission: permission() as any,
      path: draft.path,
      load: draft.load,
    })
    if (result.error) {
      toast.show({
        message: String(result.error),
        variant: "error",
      })
      return
    }
    const item = result.data!
    toast.show({
      message: item.discoverable
        ? `Created ${item.info.name}. It should remain available after restart.`
        : item.loaded
          ? `Created ${item.info.name}. It is available now, but future startup availability is not guaranteed.`
          : `Created ${item.info.name}.`,
      variant: "success",
    })
    dialog.clear()
  }

  return (
    <Switch>
      <Match when={step().type === "description"}>
        <DialogPrompt
          title="Generate agent: description"
          value={draft.description}
          placeholder="Leave blank to infer from the current session"
          onConfirm={(value) => {
            setDraft("description", value)
            setStep({ type: "model" })
          }}
        />
      </Match>
      <Match when={step().type === "model"}>
        <DialogSelect
          title="Generate agent: model"
          current={draft.model}
          flat={true}
          options={sortBy(sync.data.provider_next.all, (item) => item.name).flatMap((provider) =>
            Object.values(provider.models)
              .filter((item) => item.status !== "deprecated")
              .map((item) => ({
                value: { providerID: provider.id, modelID: item.id },
                title: item.name ?? item.id,
                description: provider.name,
                category: provider.name,
              })),
          )}
          onSelect={(option) => {
            setDraft("model", option.value)
            setStep({ type: "mode" })
          }}
        />
      </Match>
      <Match when={step().type === "mode"}>
        <DialogSelect
          title="Generate agent: mode"
          current={draft.mode}
          options={[
            { value: "all", title: "All", description: "Primary and subagent" },
            { value: "primary", title: "Primary", description: "Main agent only" },
            { value: "subagent", title: "Subagent", description: "Callable by agents" },
          ]}
          onSelect={(option) => {
            setDraft("mode", option.value as Mode)
            setStep({ type: "permissions" })
          }}
        />
      </Match>
      <Match when={step().type === "permissions"}>
        <DialogSelect
          title="Generate agent: permissions"
          legend={<text fg={theme.textMuted}>Default is none. Unset permissions stay denied via `*: deny`.</text>}
          options={[
            { value: "done", title: "Continue", description: "Review storage and loading" },
            ...PERMISSIONS.map((item) => {
              const state = draft.permission[item.id]
              const label =
                !state || state.choice === "inherit"
                  ? "Denied by default"
                  : state.choice === "custom"
                    ? `${state.rules.length} custom rule${state.rules.length === 1 ? "" : "s"}`
                    : `${state.choice} all`
              return {
                value: item.id,
                title: item.title,
                description: label,
              }
            }),
          ]}
          onSelect={(option) => {
            if (option.value === "done") {
              setStep({ type: "storage" })
              return
            }
            setStep({ type: "permission", permission: option.value as Perm })
          }}
        />
      </Match>
      <Match when={step().type === "permission"}>
        <DialogSelect
          title={`Permission: ${PERMISSIONS.find((item) => item.id === (step() as any).permission)?.title ?? ""}`}
          current={
            draft.permission[(step() as { type: "permission"; permission: Perm }).permission]?.choice ?? "inherit"
          }
          options={[
            { value: "inherit", title: "Unset", description: "Keep denied by wildcard" },
            { value: "allow", title: "Allow all", description: "Allow every matching request" },
            { value: "ask", title: "Ask all", description: "Always ask first" },
            { value: "deny", title: "Deny all", description: "Always deny" },
            { value: "custom", title: "Custom rules", description: "Switch to pattern rules" },
            ...(draft.permission[(step() as { type: "permission"; permission: Perm }).permission]?.choice === "custom"
              ? [
                  { value: "custom_allow", title: "Add allow rule", description: "Add an allow pattern" },
                  { value: "custom_ask", title: "Add ask rule", description: "Add an ask pattern" },
                  { value: "custom_deny", title: "Add deny rule", description: "Add a deny pattern" },
                  { value: "custom_clear", title: "Clear custom rules", description: "Remove all patterns" },
                  { value: "done", title: "Done", description: "Return to permissions" },
                ]
              : []),
            { value: "back", title: "Back", description: "Return to permissions" },
          ]}
          onSelect={(option) => {
            const permissionID = (step() as { type: "permission"; permission: Perm }).permission
            if (option.value === "back") {
              setStep({ type: "permissions" })
              return
            }
            if (option.value === "done") {
              setStep({ type: "permissions" })
              return
            }
            if (option.value === "custom") {
              setDraft("permission", permissionID, draft.permission[permissionID] ?? { choice: "custom", rules: [] })
              setDraft("permission", permissionID, "choice", "custom")
              setStep({ type: "permission", permission: permissionID })
              return
            }
            if (option.value === "custom_clear") {
              setDraft("permission", permissionID, { choice: "custom", rules: [] })
              return
            }
            if (option.value === "custom_allow" || option.value === "custom_ask" || option.value === "custom_deny") {
              setStep({
                type: "rule",
                permission: permissionID,
                action: option.value.replace("custom_", "") as Action,
              })
              return
            }
            if (option.value === "inherit") {
              setDraft(
                produce((state) => {
                  delete state.permission[permissionID]
                }),
              )
              setStep({ type: "permissions" })
              return
            }
            setDraft("permission", permissionID, { choice: option.value as Choice, rules: [] })
            setStep({ type: "permissions" })
          }}
        />
        <Show
          when={draft.permission[(step() as { type: "permission"; permission: Perm }).permission]?.choice === "custom"}
        >
          <CustomRules
            rules={draft.permission[(step() as { type: "permission"; permission: Perm }).permission]?.rules ?? []}
          />
        </Show>
      </Match>
      <Match when={step().type === "rule"}>
        <DialogPrompt
          title={`Add ${(step() as { type: "rule"; action: Action }).action} rule`}
          placeholder={
            PERMISSIONS.find((item) => item.id === (step() as { type: "rule"; permission: Perm }).permission)?.custom
          }
          onConfirm={(value) => {
            const next = value.trim()
            if (!next) {
              setStep({ type: "permission", permission: (step() as { type: "rule"; permission: Perm }).permission })
              return
            }
            const permissionID = (step() as { type: "rule"; permission: Perm }).permission
            const action = (step() as { type: "rule"; action: Action }).action
            setDraft("permission", permissionID, draft.permission[permissionID] ?? { choice: "custom", rules: [] })
            setDraft("permission", permissionID, "choice", "custom")
            setDraft("permission", permissionID, "rules", (rules) => [...rules, { pattern: next, action }])
            setStep({ type: "permission", permission: permissionID })
          }}
        />
      </Match>
      <Match when={step().type === "storage"}>
        <DialogSelect
          title="Generate agent: storage"
          current={draft.path}
          options={[
            ...(!globalProject()
              ? [
                  {
                    value: projectPath(),
                    title: "Project default",
                    description: projectPath(),
                  },
                ]
              : []),
            {
              value: globalPath(),
              title: "Global config",
              description: globalPath(),
            },
            {
              value: "custom",
              title: "Custom path",
              description: draft.path,
            },
          ]}
          onSelect={(option) => {
            if (option.value === "custom") {
              setStep({ type: "custom_path" })
              return
            }
            setDraft("path", option.value as string)
            setStep({ type: "load" })
          }}
        />
      </Match>
      <Match when={step().type === "custom_path"}>
        <DialogPrompt
          title="Generate agent: custom path"
          value={draft.path}
          placeholder="Directory to write the agent markdown file"
          onConfirm={(value) => {
            setDraft("path", value.trim() || draft.path)
            setStep({ type: "load" })
          }}
        />
      </Match>
      <Match when={step().type === "load"}>
        <DialogSelect
          title="Generate agent: load now"
          current={draft.load}
          options={[
            { value: true, title: "Yes", description: "Load into the current running instance" },
            { value: false, title: "No", description: "Only write the file" },
          ]}
          onSelect={(option) => {
            setDraft("load", option.value as boolean)
            setStep({ type: "review" })
          }}
        />
      </Match>
      <Match when={step().type === "review"}>
        <Review
          draft={draft}
          modelTitle={modelTitle()}
          permission={permission()}
          onConfirm={confirm}
          onEdit={(next) => setStep(next)}
        />
      </Match>
    </Switch>
  )
}

function CustomRules(props: { rules: Rule[] }) {
  const { theme } = useTheme()
  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <text fg={theme.textMuted}>Custom rules</text>
      <For each={props.rules}>
        {(rule, index) => (
          <box flexDirection="row" justifyContent="space-between">
            <text fg={theme.text}>
              {index() + 1}. {rule.action} {rule.pattern}
            </text>
          </box>
        )}
      </For>
    </box>
  )
}

function Review(props: {
  draft: Draft
  modelTitle: string
  permission: Record<string, string | Record<string, Action>>
  onConfirm: () => void
  onEdit: (step: Step) => void
}) {
  const dialog = useDialog()
  const { theme } = useTheme()
  onMount(() => dialog.setSize("large"))
  useKeyboard((evt) => {
    if (evt.name === "return") props.onConfirm()
    if (evt.name === "d") props.onEdit({ type: "description" })
    if (evt.name === "m") props.onEdit({ type: "model" })
    if (evt.name === "p") props.onEdit({ type: "permissions" })
    if (evt.name === "s") props.onEdit({ type: "storage" })
    if (evt.name === "l") props.onEdit({ type: "load" })
  })
  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Generate agent: review
        </text>
        <text fg={theme.textMuted}>esc</text>
      </box>
      <text fg={theme.text}>
        <span style={{ fg: theme.textMuted }}>Description:</span>{" "}
        {props.draft.description.trim() || "Infer from current session"}
      </text>
      <text fg={theme.text}>
        <span style={{ fg: theme.textMuted }}>Model:</span> {props.modelTitle}
      </text>
      <text fg={theme.text}>
        <span style={{ fg: theme.textMuted }}>Mode:</span> {props.draft.mode}
      </text>
      <text fg={theme.text}>
        <span style={{ fg: theme.textMuted }}>Path:</span> {props.draft.path}
      </text>
      <text fg={theme.text}>
        <span style={{ fg: theme.textMuted }}>Load now:</span> {props.draft.load ? "yes" : "no"}
      </text>
      <text fg={theme.textMuted}>Permission config</text>
      <text fg={theme.text}>{JSON.stringify(props.permission, null, 2)}</text>
      <box flexDirection="row" gap={2}>
        <text fg={theme.primary}>enter confirm</text>
        <text fg={theme.textMuted}>d description</text>
        <text fg={theme.textMuted}>m model</text>
        <text fg={theme.textMuted}>p permissions</text>
        <text fg={theme.textMuted}>s storage</text>
        <text fg={theme.textMuted}>l load</text>
      </box>
    </box>
  )
}
