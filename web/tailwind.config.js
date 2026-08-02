/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // A deliberately light, low-contrast-chrome palette. The surface and
        // ink values come from the validated reference palette.
        surface: { DEFAULT: '#fcfcfb', sunken: '#f6f6f4', raised: '#ffffff' },
        ink: { DEFAULT: '#0b0b0b', muted: '#52514e', faint: '#8a8983' },
        line: { DEFAULT: '#e6e5e1', strong: '#d5d4cf' },
        // Categorical series slots, in the fixed validated order.
        series: {
          1: '#2a78d6', 2: '#eb6834', 3: '#1baf7a', 4: '#eda100',
          5: '#e87ba4', 6: '#008300', 7: '#4a3aa7', 8: '#e34948',
        },
        good: '#1a7f4b',
        warn: '#b06a00',
        bad: '#c0392b',
      },
      fontFamily: {
        sans: ['ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      borderRadius: { xl: '0.75rem', '2xl': '1rem' },
      boxShadow: {
        card: '0 1px 2px rgba(11,11,11,0.04), 0 1px 3px rgba(11,11,11,0.03)',
        pop: '0 4px 16px rgba(11,11,11,0.08)',
      },
    },
  },
  plugins: [],
};
