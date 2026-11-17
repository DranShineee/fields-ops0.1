/** @type {import('tailwindcss').Config} */
export default {
  content: ['./views/**/*.ejs', './public/js/**/*.js'],
  theme: {
    extend: {
      colors: {
        paper: '#F7F3EA',
        cream: '#FFFDF7',
        ink: '#15171A',
        graphite: '#2A2C30',
        muted: '#6C665A',
        line: '#DCD3C1',
        sand: '#E9DFCC',
        clay: '#A8431E',
        'clay-soft': '#F0DDD2',
        moss: '#35503E',
        'moss-soft': '#DCE5D8',
        amber: '#B07A1E',
      },
      fontFamily: {
        display: ['"Space Grotesk"', '"Arial Narrow"', 'system-ui', 'sans-serif'],
        sans: ['"Public Sans"', '"Segoe UI"', 'system-ui', 'sans-serif'],
      },
      borderRadius: {
        sm: '4px',
        DEFAULT: '8px',
        lg: '16px',
        pill: '999px',
      },
      boxShadow: {
        lift: '0 18px 40px -28px rgba(21, 23, 26, 0.45)',
        panel: '0 1px 0 rgba(21, 23, 26, 0.06)',
      },
      maxWidth: {
        shell: '1240px',
      },
    },
  },
  plugins: [],
};
