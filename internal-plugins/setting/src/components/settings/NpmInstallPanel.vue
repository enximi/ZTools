<template>
  <div class="npm-install-overlay">
    <DetailPanel title="从 npm 安装插件" @back="emit('back')">
      <div class="npm-install-content">
      <div class="install-form">
        <div class="input-group">
          <label>npm 包名</label>
          <input
            ref="packageInput"
            v-model="packageName"
            type="text"
            class="input"
            placeholder="例如：@ztools/example-plugin 或 ztools-example"
            @keyup.enter="handleInstall"
          />
          <p class="input-hint">请输入 npm 包名，支持作用域包（@scope/name）</p>
        </div>

        <div class="checkbox-group">
          <label class="checkbox-label">
            <input v-model="useChinaMirror" type="checkbox" class="checkbox" />
            <span>使用国内镜像（registry.npmmirror.com）</span>
          </label>
          <p class="input-hint">国内网络环境下推荐使用，可提高下载速度</p>
        </div>

        <div class="install-actions">
          <button class="btn" @click="emit('back')">取消</button>
          <button
            class="btn btn-solid"
            :disabled="!packageName.trim() || isInstalling"
            @click="handleInstall"
          >
            {{ isInstalling ? '安装中...' : '安装' }}
          </button>
        </div>
      </div>
    </div>
  </DetailPanel>
  </div>
</template>

<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue'
import DetailPanel from '../common/DetailPanel.vue'

const props = defineProps<{
  visible?: boolean
}>()

const emit = defineEmits<{
  (e: 'back'): void
  (e: 'install', data: { packageName: string; useChinaMirror: boolean }): void
}>()

const packageName = ref('')
const useChinaMirror = ref(false)
const isInstalling = ref(false)
const packageInput = ref<HTMLInputElement>()

function handleInstall(): void {
  const name = packageName.value.trim()
  if (!name || isInstalling.value) return

  isInstalling.value = true
  emit('install', {
    packageName: name,
    useChinaMirror: useChinaMirror.value
  })
}

// 重置表单
function resetForm(): void {
  packageName.value = ''
  useChinaMirror.value = false
  isInstalling.value = false
}

// 面板显示时自动聚焦输入框
watch(
  () => props.visible,
  async (visible) => {
    if (visible) {
      resetForm()
      await nextTick()
      packageInput.value?.focus()
    }
  }
)

onMounted(() => {
  if (props.visible) {
    nextTick(() => {
      packageInput.value?.focus()
    })
  }
})

// 暴露方法供父组件使用
defineExpose({
  resetForm
})
</script>

<style scoped>
.npm-install-overlay {
  position: absolute;
  inset: 0;
  z-index: 10001;
  background: rgba(0, 0, 0, 0.75);
  backdrop-filter: blur(8px);
}

.npm-install-content {
  padding: 24px;
}

.install-form {
  max-width: 600px;
  margin: 0 auto;
}

.input-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 24px;
}

.input-group label {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-color);
}

.input-hint {
  font-size: 12px;
  color: var(--text-secondary);
  margin: 0;
}

.checkbox-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 32px;
}

.checkbox-label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  color: var(--text-color);
  cursor: pointer;
}

.checkbox {
  width: 16px;
  height: 16px;
  cursor: pointer;
  accent-color: var(--primary-color);
}

.install-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  padding-top: 16px;
  border-top: 1px solid var(--divider-color);
}
</style>
