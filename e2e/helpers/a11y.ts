import { type Page, expect } from '@playwright/test'
import { AxeBuilder } from '@axe-core/playwright'

export async function checkA11y(
  page: Page,
  options?: {
    include?: string
    exclude?: string[]
    tags?: string[]
    disableRules?: string[]
  }
) {
  const builder = new AxeBuilder({ page }).withTags(
    options?.tags ?? ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']
  )

  // BdsPopover uses <span> with aria-expanded — tracked in design-system
  const defaultDisableRules = ['aria-allowed-attr']
  builder.disableRules([...defaultDisableRules, ...(options?.disableRules ?? [])])

  if (options?.include) {
    builder.include(options.include)
  }

  for (const selector of options?.exclude ?? []) {
    builder.exclude(selector)
  }

  const results = await builder.analyze()

  const critical = results.violations.filter(
    (v) => v.impact === 'critical' || v.impact === 'serious'
  )

  if (results.violations.length > critical.length) {
    const moderate = results.violations.filter(
      (v) => v.impact !== 'critical' && v.impact !== 'serious'
    )
    console.warn(
      `[a11y] ${moderate.length} moderate/minor violation(s):`,
      moderate.map((v) => `${v.id} (${v.impact})`).join(', ')
    )
  }

  expect(critical, 'Page has critical/serious a11y violations').toEqual([])
}
