import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: { DEFAULT: '#111827', soft: '#374151', mute: '#6b7280' },
        line: '#e5e7eb',
        surface: { DEFAULT: '#ffffff', alt: '#f8fafc', sunk: '#f1f5f9' },
        brand: { 50:'#eef4ff',100:'#dbe7ff',300:'#9cb6f6',500:'#3b62c4',600:'#2f4fa3',700:'#26417f' },
        rag: { green:'#127c4c', amber:'#b1660c', red:'#b42318', grey:'#64748b' },
      },
      fontFamily: {
        sans: ['ui-sans-serif','system-ui','-apple-system','Segoe UI','Roboto','Helvetica Neue','Arial','sans-serif'],
        mono: ['ui-monospace','SFMono-Regular','Consolas','Liberation Mono','monospace'],
      },
      fontSize: { '2xs': ['0.6875rem', '1rem'] },
      boxShadow: { card: '0 1px 2px rgba(16,24,40,.06), 0 1px 3px rgba(16,24,40,.10)' },
    },
  },
  plugins: [],
};
export default config;
