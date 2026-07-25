// Nav island hides on scroll down, returns on scroll up.
const nav = document.getElementById('nav');
let lastY = window.scrollY;

addEventListener('scroll', () => {
  const y = window.scrollY;
  nav.classList.toggle('hidden', y > lastY && y > 140);
  lastY = y;
}, { passive: true });

// Fade sections in as they enter the viewport.
const observer = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (e.isIntersecting) {
      e.target.classList.add('visible');
      observer.unobserve(e.target);
    }
  }
}, { threshold: 0.25 });

document.querySelectorAll('main section').forEach((s) => {
  s.classList.add('reveal');
  observer.observe(s);
});
