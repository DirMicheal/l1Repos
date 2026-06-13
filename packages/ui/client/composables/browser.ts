import { ref, watch } from 'vue'

export type ViewportSize
  = | 'small-mobile'
    | 'large-mobile'
    | 'tablet'
export const viewport = ref<[number, number]>([414, 896])

export interface ViewportPreset {
  label: string
  width: number
  height: number
}

// Common viewports offered in the browser preview selector, ordered by width.
// The three sizes that also have quick-access buttons are included here too so
// the dropdown stays a complete list.
export const viewportPresets: ViewportPreset[] = [
  { label: 'Small mobile', width: 320, height: 568 },
  { label: 'Mobile (Android)', width: 360, height: 640 },
  { label: 'iPhone SE', width: 375, height: 667 },
  { label: 'iPhone 14', width: 390, height: 844 },
  { label: 'Pixel 7', width: 412, height: 915 },
  { label: 'Large mobile', width: 414, height: 896 },
  { label: 'iPad Mini', width: 768, height: 1024 },
  { label: 'Tablet', width: 834, height: 1112 },
  { label: 'iPad Pro 11"', width: 834, height: 1194 },
  { label: 'iPad Pro 12.9"', width: 1024, height: 1366 },
  { label: 'Laptop', width: 1280, height: 800 },
  { label: 'Desktop', width: 1440, height: 900 },
  { label: 'Full HD', width: 1920, height: 1080 },
]

watch([viewport], () => {
  document.body.style.setProperty('--viewport-width', `${viewport.value[0]}px`)
  document.body.style.setProperty('--viewport-height', `${viewport.value[1]}px`)
}, { immediate: true, flush: 'sync' })
