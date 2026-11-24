<script setup lang="ts">
// Hosted as a public demo (HOSTED_DEMO=1), the server says so on every page (server/middleware/hosted.ts).
const notice = useState('demoNotice', () => useRequestEvent()?.context.demoNotice ?? '');
</script>

<template>
  <header class="top">
    <NuxtLink to="/" class="brand">Shelfwise</NuxtLink>
    <span class="muted">Inventory</span>
  </header>
  <p v-if="notice" class="demo-notice">{{ notice }}</p>
  <main><NuxtPage /></main>
</template>
