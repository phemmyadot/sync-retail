import type { Config } from 'tailwindcss';

const token = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: { DEFAULT: token('ink'), 2: token('ink-2'), 3: token('ink-3'), 4: token('ink-4') },
        line: { DEFAULT: token('line'), strong: token('line-strong') },
        bone: token('bone'),
        dust: token('dust'),
        amber: { DEFAULT: token('amber'), ink: token('amber-ink'), deep: token('amber-deep') },
        vermilion: token('vermilion'),
        mint: token('mint'),
        sky: token('sky'),
        orchid: token('orchid'),
        paper: { DEFAULT: token('paper'), ink: token('paper-ink'), dim: token('paper-dim'), rule: token('paper-rule') },
      },
      fontFamily: {
        display: ['"Instrument Serif"', 'ui-serif', 'Georgia', 'serif'],
        sans: ['"Bricolage Grotesque"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem', letterSpacing: '0.08em' }],
      },
      borderRadius: { xs: '3px' },
      boxShadow: {
        lift: '0 1px 0 rgb(var(--line-strong)), 0 18px 40px -18px rgb(0 0 0 / 0.75)',
        key: 'inset 0 -3px 0 rgb(0 0 0 / 0.35), inset 0 1px 0 rgb(255 255 255 / 0.06)',
        glow: '0 0 0 1px rgb(var(--amber) / 0.6), 0 0 32px -6px rgb(var(--amber) / 0.55)',
      },
      transitionTimingFunction: { snap: 'cubic-bezier(.2,.9,.25,1.2)', out: 'cubic-bezier(.16,1,.3,1)' },
      keyframes: {
        rise: { from: { opacity: '0', transform: 'translateY(10px)' }, to: { opacity: '1', transform: 'none' } },
        print: { from: { clipPath: 'inset(0 0 100% 0)' }, to: { clipPath: 'inset(0 0 0 0)' } },
        pop: { '0%': { transform: 'scale(.96)', opacity: '0' }, '100%': { transform: 'scale(1)', opacity: '1' } },
        shake: { '10%,90%': { transform: 'translateX(-1px)' }, '20%,80%': { transform: 'translateX(3px)' }, '30%,50%,70%': { transform: 'translateX(-6px)' }, '40%,60%': { transform: 'translateX(6px)' } },
        flash: { from: { backgroundColor: 'rgb(var(--amber) / 0.28)' }, to: { backgroundColor: 'transparent' } },
        marquee: { from: { transform: 'translateX(0)' }, to: { transform: 'translateX(-50%)' } },
        blink: { '50%': { opacity: '0.25' } },
      },
      animation: {
        rise: 'rise .5s cubic-bezier(.16,1,.3,1) both',
        print: 'print .6s steps(14) both',
        pop: 'pop .22s cubic-bezier(.16,1,.3,1) both',
        shake: 'shake .45s cubic-bezier(.36,.07,.19,.97) both',
        flash: 'flash 1.1s ease-out',
        marquee: 'marquee 40s linear infinite',
        blink: 'blink 1.4s steps(2) infinite',
      },
    },
  },
  plugins: [],
} satisfies Config;
