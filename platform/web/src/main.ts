import { createApp } from 'vue'

// Before anything that reads the shared dictionaries.
import '@/shared/wx-shim'

import App from '@/App.vue'
import { router } from '@/router'
import { installTheme } from '@/shared/theme'
import '@/styles/app.css'

installTheme()

createApp(App).use(router).mount('#app')
