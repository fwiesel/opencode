import { createEffect, createSignal, For, on, onCleanup, Show, untrack, type Accessor, type JSX } from "solid-js"
import { frameLoop, observeReducedMotion, prefersReducedMotion, Spring, type DurationOptions } from "@opencode/ui/motion"

const enter: DurationOptions = { duration: 0.4, bounce: 0 }
const exit: DurationOptions = { duration: 0.3, bounce: 0 }
const fade: DurationOptions = { duration: 0.15, bounce: 0 }

type Face<T> = {
  key: string
  value: Accessor<T>
  set: (value: T) => void
  leaving: Accessor<boolean>
  leave: (leaving: boolean) => void
  presence: Spring
  el?: HTMLDivElement
  height: number
}

/**
 * The composer and the docks that stand in for it (a question, a permission check) as one surface. A new face grows
 * the region to its height on one spring while the old face hands over in place, so the composer transforms into the
 * dock card and back instead of swapping. Faces present on mount rest immediately.
 */
export function ComposerMorph<T extends { key: string }>(props: {
  face: T
  children: (face: Accessor<T>) => JSX.Element
}) {
  const born = performance.now()
  const [faces, setFaces] = createSignal([face(props.face, 1)])
  let root: HTMLDivElement | undefined
  let height: Spring | undefined
  let stop: (() => void) | undefined

  const settle = (list: Face<T>[]) => {
    stop?.()
    stop = undefined
    height = undefined
    root?.removeAttribute("data-moving")
    root?.removeAttribute("data-dock-border-underlay")
    root?.style.removeProperty("height")
    list.forEach((item) =>
      ["opacity", "transform", "filter", "mask-image"].forEach((prop) => item.el?.style.removeProperty(prop)),
    )
    setFaces(list.filter((item) => !item.leaving()))

    return false
  }

  const measure = () => {
    for (const item of untrack(faces)) if (item.el) item.height = item.el.offsetHeight
  }

  const styleFace = (item: Face<T>, shown: number, reduced: boolean) => {
    const el = item.el

    if (!el) return
    const p = Math.max(0, Math.min(1, item.presence.value))
    el.style.opacity = `${(p * p).toFixed(4)}`

    if (reduced) return
    const dy = item.leaving() ? (1 - p) * -4 : (1 - p) * 6
    const scale = 1 - (1 - p) * 0.02
    el.style.transform = `translateY(${dy.toFixed(2)}px) scale(${scale.toFixed(4)})`
    el.style.filter = p < 0.999 ? `blur(${((1 - p) * 4).toFixed(2)}px)` : ""
    const hidden = Math.max(0, item.height - shown)
    const edge = Math.min(24, hidden)
    el.style.maskImage = hidden > 0 ? `linear-gradient(to top, transparent ${hidden}px, #000 ${hidden + edge}px)` : ""
  }

  const paint = (dt: number) => {
    const list = untrack(faces)
    const entering = list.find((item) => !item.leaving())

    if (!root || !height || !entering) return false
    const reduced = prefersReducedMotion()

    if (entering.height > 0 && height.target !== entering.height) height.set(entering.height)

    if (reduced) height.snap(entering.height)
    height.step(dt)
    if (Math.abs(height.value - height.target) < 0.5 && Math.abs(height.velocity) < 5) height.snap(height.target)
    list.forEach((item) => {
      item.presence.step(dt)
      if (Math.abs(item.presence.value - item.presence.target) < 0.01 && Math.abs(item.presence.velocity) < 0.05)
        item.presence.snap(item.presence.target)
    })

    if (height.resting && list.every((item) => item.presence.resting)) return settle(list)
    const shown = Math.round(height.value)
    root.style.height = `${shown}px`
    list.forEach((item) => styleFace(item, shown, reduced))

    return true
  }

  createEffect(
    on(
      () => props.face,
      (next) => {
        const list = untrack(faces)
        const current = list.find((item) => !item.leaving())

        if (current?.key === next.key) return current.set(next)

        if (!root || performance.now() - born < 250) return setFaces([face(next, 1)])
        const from = height ? height.value : root.offsetHeight
        const reduced = prefersReducedMotion()
        const back = list.find((item) => item.key === next.key)
        const entering = back ?? face(next, 0)
        const active = list.filter((item) => item === entering || item.presence.value >= 0.01)

        active.forEach((item) => {
          if (item === entering) return
          item.leave(true)

          if (item.el?.contains(document.activeElement) && document.activeElement instanceof HTMLElement)
            document.activeElement.blur()
          tune(item.presence, reduced ? fade : exit).set(0)
        })
        entering.set(next)
        entering.leave(false)
        tune(entering.presence, reduced ? fade : enter).set(1)
        height ??= Spring.fromDuration(from, enter)
        tune(height, enter)
        const shown = Math.round(height.value)
        root.dataset.moving = ""
        root.dataset.dockBorderUnderlay = "true"
        root.style.height = `${shown}px`
        const nextFaces = back ? active : [...active, entering]
        nextFaces.forEach((item) => styleFace(item, shown, reduced))
        setFaces(nextFaces)
        stop ??= frameLoop.addMeasured(measure, paint)
      },
      { defer: true },
    ),
  )

  onCleanup(observeReducedMotion(() => prefersReducedMotion() && stop && settle(untrack(faces))))
  onCleanup(() => stop?.())

  return (
    <div
      ref={root}
      data-slot="composer-morph"
      class="relative flex flex-col data-[moving]:overflow-clip data-[moving]:rounded-xl data-[moving]:bg-v2-background-bg-base [[data-color-scheme=dark]_&[data-moving]]:bg-v2-background-bg-layer-01"
    >
      <For each={faces()}>
        {(item) => (
          <div
            ref={(el) => {
              item.el = el

              if (height) styleFace(item, Math.round(height.value), prefersReducedMotion())
            }}
            data-slot="composer-face"
            inert={item.leaving()}
            aria-hidden={item.leaving() || undefined}
            class="shrink-0 origin-top"
            classList={{ "pointer-events-none absolute inset-x-0 top-0": item.leaving() }}
          >
            {props.children(item.value)}
          </div>
        )}
      </For>
    </div>
  )
}

function face<T extends { key: string }>(value: T, presence: number): Face<T> {
  const [current, set] = createSignal(value)
  const [leaving, leave] = createSignal(false)

  return { key: value.key, value: current, set, leaving, leave, presence: new Spring(presence), height: 0 }
}

function tune(spring: Spring, options: DurationOptions) {
  spring.omega = (2 * Math.PI) / options.duration
  spring.zeta = 1 - options.bounce

  return spring
}

/**
 * Mounts its children when `when` turns true and grows them in; when it turns false they close and unmount. Present on
 * mount, they rest unless `appear` asks for an entrance.
 */
export function Grow(props: {
  when: boolean
  appear?: boolean
  fade?: boolean
  skirt?: number
  class?: string
  ref?: (el: HTMLDivElement) => void
  onClosed?: () => void
  children: JSX.Element
}) {
  const [present, setPresent] = createSignal(props.when)
  let el: HTMLDivElement | undefined
  let entering = props.when && !!props.appear

  createEffect(
    on(
      () => [props.when, present()] as const,
      ([when, shown], prev) => {
        if (when && !shown) {
          entering = true
          setPresent(true)

          return
        }

        if (!el || (!entering && (!prev || prev[0] === when))) return
        entering = false
        grow(el, when, {
          fade: props.fade,
          skirt: props.skirt,
          done: () => {
            setPresent(false)
            props.onClosed?.()
          },
        })
      },
    ),
  )

  return (
    <Show when={present()}>
      <div
        ref={(element) => {
          el = element
          props.ref?.(element)
        }}
        class={props.class}
      >
        {props.children}
      </div>
    </Show>
  )
}

const growing = new WeakMap<HTMLElement, { spring: Spring; open: boolean; done?: () => void }>()

function grow(el: HTMLElement, open: boolean, options: { fade?: boolean; skirt?: number; done?: () => void } = {}) {
  const current = growing.get(el)

  if (prefersReducedMotion() && !current) {
    const anim = el.animate([{ opacity: open ? 0 : 1 }, { opacity: open ? 1 : 0 }], { duration: 150, fill: "forwards" })
    void anim.finished.then(
      () => {
        anim.cancel()
        finish(el, open, options.done)
      },
      () => undefined,
    )

    return
  }

  if (current) {
    current.open = open
    current.done = options.done
    tune(current.spring, open ? enter : exit)

    return
  }

  const state = {
    spring: Spring.fromDuration(open ? 0 : el.offsetHeight, open ? enter : exit),
    open,
    done: options.done,
  }

  growing.set(el, state)
  el.dataset.growing = ""
  el.style.overflow = "clip"
  if (options.skirt) el.style.overflowClipMargin = `${options.skirt}px`
  el.style.height = `${Math.round(state.spring.value)}px`
  const inner = () => (el.firstElementChild instanceof HTMLElement ? el.firstElementChild : el)

  if (options.fade && open) {
    const node = inner()
    node.style.opacity = "0"
    node.style.filter = "blur(4px)"
  }

  let full = 0

  frameLoop.addMeasured(
    () => {
      full = natural(el)
    },
    (dt) => {
      const size = state.open ? full : 0

      if (prefersReducedMotion()) state.spring.snap(size)
      state.spring.set(size).step(dt)
      if (Math.abs(state.spring.value - size) < 0.5 && Math.abs(state.spring.velocity) < 5) state.spring.snap(size)

      if (state.spring.resting) {
        growing.delete(el)
        finish(el, state.open, state.done)

        return false
      }

      const value = Math.round(Math.max(0, state.spring.value))
      el.style.height = `${value}px`

      if (!options.fade) return true
      const p = Math.max(0, Math.min(1, state.spring.value / Math.max(1, full)))
      const node = inner()
      node.style.opacity = `${(p * p).toFixed(4)}`
      node.style.filter = p < 0.999 ? `blur(${((1 - p) * 4).toFixed(2)}px)` : ""
      node.style.transform = `translateY(${((value - full) * 0.5).toFixed(2)}px) scale(${(0.97 + 0.03 * p).toFixed(4)})`

      return true
    },
  )
}

function natural(el: HTMLElement): number {
  const child = el.firstElementChild

  if (!(child instanceof HTMLElement)) return 0
  const style = getComputedStyle(child)
  let total = child.offsetHeight + parseFloat(style.marginTop) + parseFloat(style.marginBottom)

  for (const sub of child.querySelectorAll<HTMLElement>("[data-growing]")) {
    const state = growing.get(sub)

    if (state) total += (state.open ? natural(sub) : 0) - sub.offsetHeight
  }

  return total
}

function finish(el: HTMLElement, open: boolean, done?: () => void) {
  el.removeAttribute("data-growing")
  const child = el.firstElementChild instanceof HTMLElement ? el.firstElementChild : undefined
  ;["height", "overflow", "overflow-clip-margin", "opacity", "filter", "transform", "mask-image"].forEach((prop) => {
    el.style.removeProperty(prop)
    child?.style.removeProperty(prop)
  })

  if (!open) done?.()
}
