import type { DurationOptions } from "./motion"
import { motionPresets, motionTuning, type MotionKnob, type MotionPreset } from "./motion-tuning"

const global = "Global"

/**
 * Mounts the Motion workspace into `container`: a tab per surface under the shipped values and the Snappy, Smooth and
 * Calm presets for every spring at once. Each tab shows one Global card (speed, slow motion and other settings every surface reads), then one
 * card for its surface: its springs and knobs, with its replay buttons under a Replay sub-heading. knobs loads on first
 * mount, so importing this module costs nothing until then. Works anywhere a surface registered its knobs, including
 * Storybook stories. Returns its removal.
 */
export function mountMotionPanel(
  container: HTMLElement,
  options: { title?: string; section?: string; onClose?: () => void } = {},
) {
  let unmount: (() => void) | undefined
  let disposed = false
  let section = options.section

  void start()

  return () => {
    disposed = true
    unmount?.()
  }

  async function start() {
    const { action, choice, defineControls, knob, spring, toggle } = await import("knobs")

    const field = (item: MotionKnob) => {
      const meta = { label: item.label, group: item.group, tab: item.group === global ? undefined : item.group }

      if (item.kind === "spring") return spring(item.initial, meta)

      if (item.kind === "toggle") return toggle(item.initial, meta)

      if (item.kind === "choice") return choice(item.initial, item.options, { ...meta, labels: item.labels })

      return knob(item.initial, { ...meta, min: item.min, max: item.max, step: item.step, unit: item.unit ?? "×" })
    }

    const apply = (item: MotionKnob, value: MotionKnob["value"]) => {
      if (item.kind === "spring") {
        // SAFETY: a spring knob's field is a spring field.
        return motionTuning.set(item, value as DurationOptions)
      }

      if (item.kind === "toggle") {
        // SAFETY: a toggle knob's field is a toggle field.
        return motionTuning.set(item, value as boolean)
      }

      if (item.kind === "choice") {
        // SAFETY: a choice knob's field is a choice field.
        return motionTuning.set(item, value as string)
      }

      // SAFETY: a number knob's field is a number field.
      motionTuning.set(item, value as number)
    }

    const identity = () =>
      [...motionTuning.list(), ...motionTuning.actions()].map((item) => `${item.group}/${item.id}`).join()

    // Rebuilt when a surface registers or removes a knob or action.
    const mount = () => {
      unmount?.()
      const list = motionTuning.list()
      const actions = motionTuning.actions()
      const mounted = identity()
      const springs = list.flatMap((item) => (item.kind === "spring" ? [item] : []))
      const preset = (id: MotionPreset) => Object.fromEntries(springs.map((item) => [item.id, item.presets[id]]))
      const sections = [...new Set([...list, ...actions].map((item) => item.group))].filter((group) => group !== global)

      const controls = defineControls(
        "opencode-motion",
        {
          // Global first, then each section's knobs and its replay buttons together, so each shows as one card.
          ...Object.fromEntries(list.filter((item) => item.group === global).map((item) => [item.id, field(item)])),
          ...Object.fromEntries(
            [...list, ...actions]
              .filter((item) => item.group !== global)
              .toSorted((a, b) => sections.indexOf(a.group) - sections.indexOf(b.group))
              .map((item) =>
                "run" in item
                  ? [
                      `action.${item.id}`,
                      action(item.label, { group: item.group, tab: item.group, subsection: "Replay", run: item.run }),
                    ]
                  : [item.id, field(item)],
              ),
          ),
        },
        {
          // knobs enables itself only on localhost; this module is only loaded in developer channels.
          enabled: true,
          ship: () => import("knobs/panel"),
          persist: "variants",
          // Springs ship different presets, so the defaults get their own chip.
          defaultLabel: "Shipped",
          presetLabels: motionPresets,
          presets: { snappy: preset("snappy"), smooth: preset("smooth"), calm: preset("calm") },
          onChange: (patch) =>
            list.forEach((item) => {
              // SAFETY: each field was made from its knob above, so its value is that knob's kind.
              const value = patch[item.id] as MotionKnob["value"] | undefined

              if (value !== undefined) apply(item, value)
            }),
        },
      )

      const sync = () => controls.sync(Object.fromEntries(list.map((item) => [item.id, item.value])))
      sync()

      const stopPanel = controls.mount(container, {
        theme: "auto",
        title: options.title ?? "Motion",
        onClose: options.onClose,
        tabs: sections,
        tab: section,
        onTab: (id) => (section = id),
      })

      const stopWatch = motionTuning.subscribe(() => {
        // Edits from elsewhere, such as the debug bar's SLOW, show here too.
        if (identity() === mounted) return sync()
        mount()
      })

      unmount = () => {
        stopWatch()
        stopPanel()
      }
    }

    if (!disposed) mount()
  }
}
