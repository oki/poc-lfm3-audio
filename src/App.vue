<script setup>
import { ref, computed } from "vue";
import { useTranscriber, METER_MAX } from "./useTranscriber.js";

const prompt = ref("You are a transcription engine. Write down exactly what the user said, verbatim, in the language they spoke. Output only the transcription, no comments.");
const { status, listening, ready, level, threshold, lines, toggle, apply, copy, text } = useTranscriber(prompt);
const hasText = computed(() => lines.value.some((l) => !l.sep));
const pct = (v) => Math.min(100, v / METER_MAX * 100);
</script>

<template>
  <main class="mx-auto max-w-2xl px-4 py-16 space-y-12 text-base-content">
    <header class="space-y-2">
      <h1 class="font-display text-[32px] font-semibold leading-tight">Transcription</h1>
      <p class="text-sm text-base-content/60">Local speech to text with llama-server and the LFM3-Audio model.</p>
    </header>

    <section class="space-y-4">
      <label class="block space-y-2">
        <span class="text-sm font-medium">System prompt</span>
        <textarea v-model="prompt" rows="3" class="textarea w-full"></textarea>
      </label>
      <button class="btn btn-ghost btn-sm" @click="apply">Apply and start a new session</button>
    </section>

    <section class="space-y-6">
      <div class="flex flex-wrap items-center gap-4">
        <button class="btn min-h-11 px-8" :class="listening ? 'btn-error' : 'btn-primary'" :disabled="!ready" @click="toggle">
          {{ listening ? "Stop" : "Start" }}
        </button>
        <span class="text-sm text-base-content/70" role="status">{{ status }}</span>
      </div>

      <label class="block space-y-2">
        <span class="text-sm font-medium">Sensitivity</span>
        <div class="flex items-center gap-4">
          <input v-model.number="threshold" type="range" min="0.003" max="0.1" step="0.001" class="range range-primary range-xs w-48">
          <div class="relative flex-1">
            <progress class="progress progress-success h-2 w-full" :value="pct(level)" max="100"></progress>
            <span class="absolute inset-y-0 w-0.5 bg-base-content" :style="{ left: pct(threshold) + '%' }" aria-hidden="true"></span>
          </div>
        </div>
      </label>
    </section>

    <section class="space-y-4">
      <div class="flex items-center justify-between">
        <h2 class="font-display text-xl font-medium">Transcript</h2>
        <button class="btn btn-outline btn-sm" :disabled="!hasText" @click="copy">Copy text</button>
      </div>
      <div class="card border border-base-300 bg-base-100">
        <div class="card-body space-y-4 min-h-32">
          <p v-if="!hasText" class="text-base-content/50">Click Start and begin speaking.</p>
          <template v-for="(l, i) in lines" :key="i">
            <div v-if="l.sep" class="divider text-xs text-base-content/50 my-0">{{ l.text }}</div>
            <p v-else class="leading-relaxed">{{ l.text }}</p>
          </template>
        </div>
      </div>
    </section>
  </main>
</template>
