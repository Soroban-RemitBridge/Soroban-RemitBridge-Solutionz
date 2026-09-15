// Tailwind v4 ships as a PostCSS plugin that handles vendor prefixing itself,
// so there is no separate autoprefixer entry here.
export default {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};
