(() => {
  const doc = document.documentElement;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)').matches;

  const rafThrottle = (fn) => {
    let queued = false;
    let lastEvent = null;
    return (event) => {
      lastEvent = event;
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        fn(lastEvent);
      });
    };
  };

  /* Navigasi mobile */
  const toggle = document.querySelector('[data-nav-toggle]');
  const nav = document.querySelector('[data-nav]');
  if (toggle && nav) {
    toggle.addEventListener('click', () => {
      const open = nav.classList.toggle('is-open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && nav.classList.contains('is-open')) {
        nav.classList.remove('is-open');
        toggle.setAttribute('aria-expanded', 'false');
        toggle.focus();
      }
    });
  }

  /* Header mengecil saat halaman digulir */
  const header = document.querySelector('.site-header');
  if (header) {
    const paintHeader = () => header.classList.toggle('is-scrolled', window.scrollY > 12);
    paintHeader();
    window.addEventListener('scroll', rafThrottle(paintHeader), { passive: true });
  }

  /* Reveal otomatis di semua halaman */
  const autoRevealSelectors = [
    'main .section-head',
    '.service-card',
    '.quote',
    '.stat-card',
    '.stat-cards > *',
    '.stat-strip > div',
    '.detail-grid > *',
    '.split > section',
    '.form-card',
    '.page-head',
    '.hero-mini',
    '.faq-item',
    '.empty-state',
    '.panel-body > .surface',
    '.panel-body > section',
    '.panel-body > .table-wrap',
    '.booking-card',
    '.notification-item',
    '.category-cell',
  ];

  const revealTargets = new Set(document.querySelectorAll('.reveal, [data-reveal]'));
  if (!reduceMotion) {
    document.querySelectorAll(autoRevealSelectors.join(',')).forEach((element) => {
      if (element.closest('[data-how], .hero-collage, .site-header, .main-nav')) return;
      revealTargets.add(element);
    });
  }

  const revealItems = [...revealTargets];
  if (revealItems.length && !reduceMotion && 'IntersectionObserver' in window) {
    doc.classList.add('reveal-ready');
    revealItems.forEach((item) => {
      if (!item.hasAttribute('data-reveal')) item.setAttribute('data-reveal', 'up');
      const siblings = item.parentElement ? [...item.parentElement.children] : [];
      const order = Math.min(siblings.indexOf(item), 6);
      if (order > 0) item.style.transitionDelay = `${order * 70}ms`;
    });

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible');
            observer.unobserve(entry.target);
          }
        }
      },
      { threshold: 0.06, rootMargin: '0px 0px -6% 0px' },
    );
    revealItems.forEach((item) => observer.observe(item));

    /* Jaring pengaman: lompatan gulir (anchor/refresh) tetap memunculkan konten */
    const sweepReveal = () => {
      let remaining = 0;
      revealItems.forEach((item) => {
        if (item.classList.contains('is-visible')) return;
        if (item.getBoundingClientRect().top < window.innerHeight * 1.02) item.classList.add('is-visible');
        else remaining += 1;
      });
      if (remaining === 0) window.removeEventListener('scroll', onSweepScroll);
    };
    const onSweepScroll = rafThrottle(sweepReveal);
    window.addEventListener('scroll', onSweepScroll, { passive: true });
    window.addEventListener('load', sweepReveal);
    sweepReveal();
  }

  /* Teks kinetik pada judul hero */
  const kineticTarget =
    document.querySelector('[data-kinetic]') ||
    document.querySelector('.hero-copy-inner .display') ||
    document.querySelector('.display');
  if (kineticTarget && !reduceMotion && !kineticTarget.querySelector('.kin-word')) {
    let wordIndex = 0;
    const wrap = (node) => {
      for (const child of [...node.childNodes]) {
        if (child.nodeType === Node.TEXT_NODE) {
          const fragment = document.createDocumentFragment();
          for (const part of child.textContent.split(/(\s+)/)) {
            if (!part) continue;
            if (/^\s+$/.test(part)) {
              fragment.appendChild(document.createTextNode(' '));
              continue;
            }
            const span = document.createElement('span');
            span.className = 'kin-word';
            span.style.setProperty('--kw', String(wordIndex));
            wordIndex += 1;
            span.textContent = part;
            fragment.appendChild(span);
          }
          child.replaceWith(fragment);
        }
      }
    };
    wrap(kineticTarget);
  }

  /* Hero kolase: panah < > mengganti gambar & layanan unggulan */
  document.querySelectorAll('[data-hero-slider]').forEach((slider) => {
    const slides = [...slider.querySelectorAll('[data-slide]')];
    if (!slides.length) return;
    const serviceName = slider.querySelector('[data-hero-service]');
    const servicePrice = slider.querySelector('[data-hero-price]');
    let index = 0;

    const show = (next) => {
      index = (next + slides.length) % slides.length;
      slides.forEach((slide, i) => slide.classList.toggle('is-active', i === index));
      const active = slides[index];
      if (serviceName && active.dataset.service) serviceName.textContent = active.dataset.service;
      if (servicePrice && active.dataset.price) servicePrice.textContent = active.dataset.price;
    };

    slider.querySelectorAll('[data-dir]').forEach((button) => {
      button.addEventListener('click', () => show(index + (button.dataset.dir === 'next' ? 1 : -1)));
    });
    show(0);
  });

  /* Hero reaktif: kotak mengikuti kursor, terutama panel oranye */
  if (finePointer && !reduceMotion) {
    document.querySelectorAll('[data-tilt]').forEach((tile) => {
      const strength = tile.hasAttribute('data-tilt-warm') ? 5 : 3.2;
      tile.addEventListener('pointermove', (event) => {
        const rect = tile.getBoundingClientRect();
        const x = (event.clientX - rect.left) / rect.width;
        const y = (event.clientY - rect.top) / rect.height;
        tile.classList.add('is-hover');
        tile.style.setProperty('--glow-x', `${(x * 100).toFixed(1)}%`);
        tile.style.setProperty('--glow-y', `${(y * 100).toFixed(1)}%`);
        tile.style.setProperty('--ry', `${((x - 0.5) * strength * 2).toFixed(2)}deg`);
        tile.style.setProperty('--rx', `${(-(y - 0.5) * strength).toFixed(2)}deg`);
      });
      tile.addEventListener('pointerleave', () => {
        tile.classList.remove('is-hover');
        tile.style.setProperty('--rx', '0deg');
        tile.style.setProperty('--ry', '0deg');
      });
    });
  }

  /* Section cara kerja: gambar dulu, klik membuka penjelasan, gulir melanjutkan */
  const how = document.querySelector('[data-how]');
  if (how) {
    const track = how.querySelector('[data-how-track]');
    const mosaic = how.querySelector('.how-mosaic');
    const tiles = [...how.querySelectorAll('[data-how-tile]')];
    const steps = [...how.querySelectorAll('[data-how-step]')];
    const progressBar = how.querySelector('[data-how-bar]');
    let active = 0;
    let opened = false;
    let clickY = -1;
    let scrollLockUntil = 0;

    if ('IntersectionObserver' in window) {
      const liveObserver = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => how.classList.toggle('is-live', entry.isIntersecting));
        },
        { threshold: 0.12 },
      );
      liveObserver.observe(track || how);
    } else {
      how.classList.add('is-live');
    }

    const paint = (next, animate) => {
      active = Math.max(0, Math.min(steps.length - 1, next));
      tiles.forEach((tile, i) => {
        tile.classList.toggle('is-active', i === active);
        tile.classList.toggle('is-dim', i !== active);
        tile.setAttribute('aria-expanded', opened && i === active ? 'true' : 'false');
      });
      if (progressBar) progressBar.style.width = `${((active + 1) / steps.length) * 100}%`;
      steps.forEach((step, i) => {
        const isActive = i === active;
        if (!isActive) step.hidden = true;
      });
      const step = steps[active];
      if (!step) return;
      step.hidden = false;
      if (animate) {
        step.classList.remove('how-step-enter');
        void step.offsetWidth;
        step.classList.add('how-step-enter');
      }
    };

    const open = (index) => {
      const first = !opened;
      opened = true;
      clickY = window.scrollY;
      scrollLockUntil = performance.now() + 750;
      how.classList.add('is-open');
      paint(index, true);
      if (first) {
        const tile = tiles[index];
        if (tile) tile.focus({ preventScroll: true });
      }
      /* Di layar kecil panel berada di bawah mosaik: bawa pembaca ke penjelasan */
      if (window.matchMedia('(max-width: 720px)').matches) {
        const panel = how.querySelector('[data-how-panel]');
        if (panel) panel.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'nearest' });
      }
    };

    const close = () => {
      opened = false;
      how.classList.remove('is-open');
      tiles.forEach((tile) => tile.setAttribute('aria-expanded', 'false'));
    };

    tiles.forEach((tile, i) => {
      tile.addEventListener('click', () => open(i));
      /* Klik dua kali pada banner: kembali ke mosaik penuh & tutup penjelasan */
      tile.addEventListener('dblclick', (event) => {
        event.preventDefault();
        close();
      });
    });
    if (mosaic) mosaic.addEventListener('dblclick', (event) => {
      if (event.target === mosaic) close();
    });

    const paintStep = () => {
      if (!opened || !track) return;
      /* Setelah klik, beri jeda agar posisi gulir (scroll anchoring) tidak menimpa pilihan */
      if (performance.now() < scrollLockUntil) return;
      if (Math.abs(window.scrollY - clickY) < 80) return;
      const total = track.offsetHeight - window.innerHeight;
      if (total <= 0) return;
      const progress = Math.min(0.999, Math.max(0, -track.getBoundingClientRect().top / total));
      const next = Math.min(steps.length - 1, Math.floor(progress * steps.length));
      if (next !== active) paint(next, true);
    };
    window.addEventListener('scroll', rafThrottle(paintStep), { passive: true });
    paint(0, false);
  }

  /* Parallax ringan pada gambar bertanda data-parallax */
  if (finePointer && !reduceMotion) {
    const parallaxItems = [...document.querySelectorAll('[data-parallax]')];
    if (parallaxItems.length) {
      const paintParallax = () => {
        for (const item of parallaxItems) {
          const rect = item.getBoundingClientRect();
          if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
          const offset = (rect.top + rect.height / 2 - window.innerHeight / 2) * -0.03;
          item.style.transform = `translate3d(0, ${offset.toFixed(2)}px, 0)`;
        }
      };
      paintParallax();
      window.addEventListener('scroll', rafThrottle(paintParallax), { passive: true });
    }
  }

  /* Sorot kartu mengikuti kursor */
  if (finePointer && !reduceMotion) {
    document.querySelectorAll('.service-card, .quote').forEach((card) => {
      card.addEventListener('pointermove', (event) => {
        const rect = card.getBoundingClientRect();
        card.style.setProperty('--mx', `${((event.clientX - rect.left) / rect.width) * 100}%`);
        card.style.setProperty('--my', `${((event.clientY - rect.top) / rect.height) * 100}%`);
      });
    });
  }

  /* Progress bar scroll */
  if (!reduceMotion) {
    const bar = document.createElement('div');
    bar.className = 'scroll-progress';
    bar.setAttribute('aria-hidden', 'true');
    document.body.appendChild(bar);

    const updateProgress = () => {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      const ratio = max > 0 ? Math.min(1, window.scrollY / max) : 0;
      bar.style.width = `${(ratio * 100).toFixed(2)}%`;
    };
    window.addEventListener('scroll', rafThrottle(updateProgress), { passive: true });
    window.addEventListener('resize', updateProgress);
    updateProgress();
  }

  /* Konfirmasi aksi sensitif */
  document.querySelectorAll('[data-confirm]').forEach((element) => {
    const handler = (event) => {
      if (!window.confirm(element.dataset.confirm)) {
        event.preventDefault();
      }
    };
    element.addEventListener('click', handler);
    if (element.tagName === 'FORM') element.addEventListener('submit', handler);
  });

  /* Nama berkas pada input file */
  document.querySelectorAll('[data-file-input]').forEach((input) => {
    const target = document.querySelector(`[data-file-name="${input.dataset.fileInput}"]`);
    if (!target) return;
    input.addEventListener('change', () => {
      target.textContent = input.files && input.files[0] ? input.files[0].name : 'Belum ada berkas dipilih';
    });
  });

  /* Ripple halus pada tombol */
  if (!reduceMotion) {
    document.querySelectorAll('.btn').forEach((button) => {
      button.addEventListener('pointerdown', (event) => {
        const rect = button.getBoundingClientRect();
        const ripple = document.createElement('span');
        ripple.className = 'btn-ripple';
        ripple.style.left = `${event.clientX - rect.left}px`;
        ripple.style.top = `${event.clientY - rect.top}px`;
        button.appendChild(ripple);
        setTimeout(() => ripple.remove(), 600);
      });
    });
  }

  /* Halaman daftar: tampilkan formulir tambahan untuk calon teknisi */
  const roleRadios = document.querySelectorAll('input[name="role"]');
  const techFields = document.querySelector('[data-tech-fields]');
  const submitLabel = document.querySelector('[data-submit-label]');
  if (roleRadios.length && techFields) {
    const syncRole = () => {
      const isTech = [...roleRadios].some((radio) => radio.value === 'technician' && radio.checked);
      techFields.hidden = !isTech;
      techFields.querySelectorAll('input, textarea, select').forEach((field) => {
        if (field.type === 'checkbox' || field.type === 'radio') return;
        field.required = isTech;
      });
      if (submitLabel) submitLabel.textContent = isTech ? 'Kirim pengajuan teknisi' : 'Buat akun customer';
      document.querySelectorAll('[data-role-hint]').forEach((hint) => {
        hint.hidden = hint.dataset.roleHint !== (isTech ? 'technician' : 'customer');
      });
    };
    roleRadios.forEach((radio) => radio.addEventListener('change', syncRole));
    syncRole();
  }

  /* Tampilkan / sembunyikan kata sandi */
  document.querySelectorAll('[data-pw-toggle]').forEach((button) => {
    button.addEventListener('click', () => {
      const input = document.getElementById(button.dataset.pwToggle);
      if (!input) return;
      const visible = input.type === 'text';
      input.type = visible ? 'password' : 'text';
      button.textContent = visible ? 'Lihat' : 'Tutup';
      button.setAttribute('aria-label', visible ? 'Tampilkan kata sandi' : 'Sembunyikan kata sandi');
    });
  });

  /* Salin kode booking */
  document.querySelectorAll('[data-copy]').forEach((button) => {
    button.addEventListener('click', async () => {
      const value = button.dataset.copy;
      try {
        await navigator.clipboard.writeText(value);
        const original = button.textContent;
        button.textContent = 'Tersalin';
        setTimeout(() => {
          button.textContent = original;
        }, 1600);
      } catch {
        window.prompt('Salin kode booking:', value);
      }
    });
  });
})();
