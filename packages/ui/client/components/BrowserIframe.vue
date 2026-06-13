<script setup lang="ts">
import type { ViewportSize } from '~/composables/browser'
import { computed, onMounted, onUnmounted, ref, useTemplateRef, watch } from 'vue'
import { viewport, viewportPresets } from '~/composables/browser'
import { browserState } from '~/composables/client'
import {
  detailsPanelVisible,
  detailsPosition,
  panels,
  showNavigationPanel,
  updateBrowserPanel,
} from '~/composables/navigation'
import IconButton from './IconButton.vue'

const sizes: Record<ViewportSize, [width: number, height: number]> = {
  'small-mobile': [320, 568],
  'large-mobile': [414, 896],
  'tablet': [834, 1112],
}

function isViewport(name: ViewportSize) {
  const preset = sizes[name]
  return viewport.value[0] === preset[0] && viewport.value[1] === preset[1]
}

// Single funnel for every viewport change so the webdriverio panel refresh
// (it can't CSS-scale, so the panel width is derived from the viewport width)
// is never skipped, no matter which control triggered the change.
function applyViewport(width: number, height: number) {
  viewport.value = [width, height]
  if (browserState?.provider === 'webdriverio') {
    updateBrowserPanel()
  }
}

function changeViewport(name: ViewportSize) {
  applyViewport(...sizes[name])
}

const selectedPreset = computed(() => {
  const [width, height] = viewport.value
  return viewportPresets.find(preset => preset.width === width && preset.height === height)?.label ?? ''
})

function changePreset(event: Event) {
  const label = (event.target as HTMLSelectElement).value
  const preset = viewportPresets.find(preset => preset.label === label)
  if (preset) {
    applyViewport(preset.width, preset.height)
  }
}

const customWidth = ref(viewport.value[0])
const customHeight = ref(viewport.value[1])

watch(viewport, ([width, height]) => {
  customWidth.value = width
  customHeight.value = height
})

function applyCustomViewport() {
  const width = Math.round(Number(customWidth.value))
  const height = Math.round(Number(customHeight.value))
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    return
  }
  applyViewport(width, height)
}

const testContainer = useTemplateRef('tester-ui')
const testContainerRect = ref<DOMRectReadOnly | null>(null)

const observer = new ResizeObserver(([entry]) => {
  testContainerRect.value = entry.contentRect
})
onMounted(() => {
  if (testContainer.value) {
    observer.observe(testContainer.value)
  }
})
onUnmounted(() => {
  observer.disconnect()
})

const scale = computed(() =>
  testContainerRect.value
    ? Math.floor(
        Math.min(
          testContainerRect.value.width / viewport.value[0],
          testContainerRect.value.height / viewport.value[1],
        ) * 100,
      )
    : 100,
)
</script>

<template>
  <div id="browser-frame" h="full" flex="~ col">
    <div p="3" h-10 flex="~ gap-2" items-center bg-header border="b base">
      <IconButton
        v-show="panels.navigation <= 15"
        v-tooltip.bottom="'Show Navigation Panel'"
        title="Show Navigation Panel"
        rotate-180
        icon="i-carbon:side-panel-close"
        @click="showNavigationPanel()"
      />
      <div class="i-carbon-content-delivery-network" />
      <span pl-1 font-bold text-sm flex-auto ws-nowrap overflow-hidden truncate>Browser UI</span>
      <IconButton
        v-show="detailsPosition === 'right' && !detailsPanelVisible"
        v-tooltip.bottom="'Show Details Panel'"
        title="Show Details Panel"
        icon="i-carbon:side-panel-close"
        @click="detailsPanelVisible = true"
      />
    </div>
    <div p="l3 y2 r2" flex="~ gap-2 wrap" items-center bg-header border="b-2 base">
      <IconButton
        v-tooltip.bottom="'Small mobile'"
        title="Small mobile"
        icon="i-carbon:mobile"
        :active="isViewport('small-mobile')"
        @click="changeViewport('small-mobile')"
      />
      <IconButton
        v-tooltip.bottom="'Large mobile'"
        title="Large mobile"
        icon="i-carbon:mobile-add"
        :active="isViewport('large-mobile')"
        @click="changeViewport('large-mobile')"
      />
      <IconButton
        v-tooltip.bottom="'Tablet'"
        title="Tablet"
        icon="i-carbon:tablet"
        :active="isViewport('tablet')"
        @click="changeViewport('tablet')"
      />
      <div class="w-px h-4 bg-gray-500 op30" />
      <select
        v-tooltip.bottom="'Choose a viewport preset'"
        title="Viewport preset"
        data-testid="browser-viewport-preset"
        class="px-1 py-0.5 bg-transparent border border-base rounded text-sm outline-none cursor-pointer"
        :value="selectedPreset"
        @change="changePreset"
      >
        <option value="">
          Custom
        </option>
        <option v-for="preset in viewportPresets" :key="preset.label" :value="preset.label">
          {{ preset.label }} ({{ preset.width }}×{{ preset.height }})
        </option>
      </select>
      <div flex="~ gap-1" items-center>
        <input
          v-model.number="customWidth"
          type="number"
          min="1"
          title="Custom width"
          data-testid="browser-viewport-width"
          class="w-14 px-1 py-0.5 bg-transparent border border-base rounded text-sm text-center outline-none"
          @keydown.enter="applyCustomViewport"
        >
        <span text-sm op70>×</span>
        <input
          v-model.number="customHeight"
          type="number"
          min="1"
          title="Custom height"
          data-testid="browser-viewport-height"
          class="w-14 px-1 py-0.5 bg-transparent border border-base rounded text-sm text-center outline-none"
          @keydown.enter="applyCustomViewport"
        >
        <IconButton
          v-tooltip.bottom="'Apply custom size'"
          title="Apply custom size"
          icon="i-carbon:checkmark"
          data-testid="browser-viewport-apply"
          @click="applyCustomViewport"
        />
      </div>
      <span class="pointer-events-none" text-sm data-testid="browser-viewport-size">
        {{ viewport[0] }}x{{ viewport[1] }}px
        <span v-if="scale < 100">({{ scale }}%)</span>
      </span>
    </div>
    <div id="tester-ui" ref="tester-ui">
      Select a test to run
    </div>
  </div>
</template>

<style scoped>
#tester-ui {
  height: 100%;
  container-type: size;

  margin-top: 0.5rem;
}

#tester-ui:not([data-ready]) {
  display: flex;
  align-items: center;
  justify-content: center;

  opacity: 0.7;

  font-weight: 300;
}
</style>
