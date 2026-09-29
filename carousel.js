(() => {
  const cards = [...document.querySelectorAll('.card')];
  const dots = [...document.querySelectorAll('.dot')];
  const prev = document.querySelector('.prev');
  const next = document.querySelector('.next');
  const stage = document.querySelector('.carousel-stage');
  let current = 0;
  let startX = 0;
  let startY = 0;

  function show(index) {
    current = (index + cards.length) % cards.length;
    cards.forEach((card, i) => card.classList.toggle('active', i === current));
    dots.forEach((dot, i) => dot.classList.toggle('active', i === current));
  }

  prev.addEventListener('click', () => show(current - 1));
  next.addEventListener('click', () => show(current + 1));
  dots.forEach(dot => dot.addEventListener('click', () => show(Number(dot.dataset.index))));

  stage.addEventListener('touchstart', e => {
    const t = e.changedTouches[0];
    startX = t.clientX;
    startY = t.clientY;
  }, {passive:true});

  stage.addEventListener('touchend', e => {
    const t = e.changedTouches[0];
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;
    if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy)) {
      show(current + (dx < 0 ? 1 : -1));
    }
  }, {passive:true});

  document.addEventListener('keydown', e => {
    if (e.key === 'ArrowLeft') show(current - 1);
    if (e.key === 'ArrowRight') show(current + 1);
  });
})();
