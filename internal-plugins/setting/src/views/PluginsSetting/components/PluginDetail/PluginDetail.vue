<script setup lang="ts">
import { PluginDetail as SharedPluginDetail } from '@/components'

defineProps<{
  plugin: any
  isLoading?: boolean
  isRunning?: boolean
  isPinned?: boolean
  isDisabled?: boolean
}>()

defineEmits<{
  (e: 'back'): void
  (e: 'open'): void
  (e: 'download'): void
  (e: 'upgrade'): void
  (e: 'uninstall'): void
  (e: 'kill'): void
  (e: 'open-folder'): void

  (e: 'toggle-pin'): void
  (e: 'toggle-disabled', disabled: boolean): void
}>()
</script>

<template>
  <SharedPluginDetail
    :plugin="plugin"
    :is-loading="isLoading"
    :is-running="isRunning"
    :is-pinned="isPinned"
    :is-disabled="isDisabled"
    :show-pin-button="true"
    :show-disable-toggle="true"
    :show-size="false"
    @back="$emit('back')"
    @open="$emit('open')"
    @download="$emit('download')"
    @upgrade="$emit('upgrade')"
    @uninstall="$emit('uninstall')"
    @kill="$emit('kill')"
    @open-folder="$emit('open-folder')"
    @toggle-pin="$emit('toggle-pin')"
    @toggle-disabled="$emit('toggle-disabled', $event)"
  />
</template>
