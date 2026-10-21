import { createMemo, Match, Switch, type JSX } from "solid-js"
import type { FormInfo, PermissionRequest } from "@opencode/client/promise"
import { SessionPermissionDock } from "@/session/requests/session-permission-dock"
import { SessionQuestionDock } from "@/session/requests/session-question-dock"
import { SessionWebSearchDock } from "@/session/requests/session-websearch-dock"
import type { SessionComposerRegionController } from "./session-composer-region-controller"
import { ComposerMorph } from "./spring-height"

type Face = {
  key: string
  kind: "websearch" | "question" | "permission" | "composer" | "subagent" | "none"
  question?: FormInfo
  permission?: PermissionRequest
}

type SessionComposerRegionState = Pick<
  SessionComposerRegionController["state"],
  "questionRequest" | "websearch" | "permissionRequest" | "permissionResponding" | "decide" | "blocked"
>

export type SessionComposerRegionViewController = Pick<
  SessionComposerRegionController,
  "centered" | "onResponseSubmit" | "setDockRef" | "child" | "showComposer"
> & { state: SessionComposerRegionState }

export function SessionComposerRegion(props: {
  controller: SessionComposerRegionViewController
  composer: JSX.Element
  subagent: JSX.Element
}) {
  const controller = props.controller

  const face = createMemo((): Face => {
    const websearch = controller.state.websearch.request()

    if (websearch) return { key: `websearch:${websearch.id}`, kind: "websearch" }
    const question = controller.state.questionRequest()

    if (question) return { key: `question:${question.id}`, kind: "question", question }
    const permission = controller.state.permissionRequest()

    if (permission) return { key: `permission:${permission.id}`, kind: "permission", permission }

    if (!controller.showComposer()) return { key: "none", kind: "none" }

    return controller.child() ? { key: "subagent", kind: "subagent" } : { key: "composer", kind: "composer" }
  })

  return (
    <div
      ref={controller.setDockRef}
      data-component="session-composer-dock"
      class="w-full shrink-0 flex flex-col justify-center items-center pb-3 pointer-events-none"
    >
      {/* Only the docks and composer take the pointer; the gaps beside them belong to the timeline underneath. */}
      <div
        classList={{
          "w-full px-3 *:pointer-events-auto": true,
          "md:max-w-session md:mx-auto": controller.centered(),
        }}
      >
        <ComposerMorph face={face()}>
          {(current) => (
            <Switch>
              <Match when={current().kind === "websearch"}>
                <SessionWebSearchDock model={controller.state.websearch} onSubmit={controller.onResponseSubmit} />
              </Match>
              <Match when={current().question}>
                {(request) => <SessionQuestionDock request={request()} onSubmit={controller.onResponseSubmit} />}
              </Match>
              <Match when={current().permission}>
                {(request) => (
                  <SessionPermissionDock
                    request={request()}
                    responding={controller.state.permissionResponding()}
                    onDecide={(response) => {
                      controller.onResponseSubmit()
                      controller.state.decide(response)
                    }}
                  />
                )}
              </Match>
              <Match when={current().kind === "subagent"}>
                <div class="relative z-[70]">{props.subagent}</div>
              </Match>
              <Match when={current().kind === "composer"}>
                <div class="relative z-[70]">{props.composer}</div>
              </Match>
            </Switch>
          )}
        </ComposerMorph>
      </div>
    </div>
  )
}
