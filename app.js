// ═══════════════════════════════════════════════════════════
// Ponto JFL — lógica do app
// ═══════════════════════════════════════════════════════════
(function () {
  "use strict";

  const CONFIG = window.PONTO_CONFIG;
  const sb = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);

  const $ = (id) => document.getElementById(id);

  const state = {
    session: null,
    user: null,
    isAdmin: false,
    colaborador: null, // linha de ponto_colaboradores, quando não-admin
    colaboradoresCache: [],
    prediosCache: [],
    proximoTipoHoje: "entrada",
    forceChangePassword: false,
    lastReport: null, // { mode, rows, headers, filename }
  };

  const ERROS = {
    cpf_invalido: "CPF inválido. Confira os números digitados.",
    cpf_ja_cadastrado: "Já existe um colaborador cadastrado com esse CPF.",
    nome_obrigatorio: "Informe o nome do colaborador.",
    forbidden: "Você não tem permissão de administrador para essa ação.",
    unauthorized: "Sessão expirada. Faça login novamente.",
    colaborador_nao_encontrado: "Colaborador não encontrado.",
    colaborador_id_obrigatorio: "Selecione um colaborador.",
    predio_invalido: "Prédio selecionado é inválido.",
  };
  function friendly(msg) {
    return ERROS[msg] || msg || "Ocorreu um erro inesperado. Tente novamente.";
  }

  // ── Utilidades de data/hora (fuso America/Sao_Paulo) ─────
  function onlyDigits(s) {
    return String(s || "").replace(/\D/g, "");
  }
  function formatCPF(cpf) {
    const d = onlyDigits(cpf);
    if (d.length !== 11) return cpf || "—";
    return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
  }
  function isValidCPF(cpf) {
    const d = onlyDigits(cpf);
    if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
    let soma = 0;
    for (let i = 0; i < 9; i++) soma += parseInt(d[i], 10) * (10 - i);
    let resto = (soma * 10) % 11;
    if (resto === 10) resto = 0;
    if (resto !== parseInt(d[9], 10)) return false;
    soma = 0;
    for (let i = 0; i < 10; i++) soma += parseInt(d[i], 10) * (11 - i);
    resto = (soma * 10) % 11;
    if (resto === 10) resto = 0;
    if (resto !== parseInt(d[10], 10)) return false;
    return true;
  }
  function dateKeySP(iso) {
    return new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
  }
  function timeSP(iso) {
    return new Date(iso).toLocaleTimeString("pt-BR", {
      timeZone: "America/Sao_Paulo",
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  function todayKeySP() {
    return new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
  }
  function fmtDateBR(key) {
    const [y, m, d] = key.split("-");
    return `${d}/${m}/${y}`;
  }
  function weekdayOf(key) {
    return new Date(key + "T00:00:00Z").getUTCDay(); // 0=dom ... 6=sáb
  }
  function fmtHoras(h) {
    if (!h || h < 0) return "0h00";
    const totalMin = Math.round(h * 60);
    const hh = Math.floor(totalMin / 60);
    const mm = totalMin % 60;
    return `${hh}h${String(mm).padStart(2, "0")}`;
  }
  function addDaysKey(key, days) {
    const d = new Date(key + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }
  function boundsISO(inicioKey, fimKey) {
    return {
      startISO: `${inicioKey}T00:00:00-03:00`,
      endISO: `${fimKey}T23:59:59.999-03:00`,
    };
  }

  // ── Views ─────────────────────────────────────────────────
  function showOnly(id) {
    ["view-loading", "view-login", "view-app"].forEach((v) => {
      $(v).hidden = v !== id;
    });
  }
  function showLoginError(msg) {
    const el = $("login-msg");
    el.textContent = msg;
    el.hidden = !msg;
  }

  function showAppSection(which) {
    $("view-colaborador").hidden = which !== "colaborador";
    $("view-admin").hidden = which !== "admin";
  }

  // ── Invocar Edge Functions ────────────────────────────────
  async function invokeFn(name, body) {
    const { data, error } = await sb.functions.invoke(name, { body });
    if (error) {
      let detail = error.message;
      try {
        if (error.context && typeof error.context.json === "function") {
          const ctx = await error.context.json();
          detail = ctx.error || detail;
        }
      } catch (_e) {
        /* ignora */
      }
      throw new Error(friendly(detail));
    }
    return data;
  }

  // ── Geolocalização ────────────────────────────────────────
  function getLocation() {
    return new Promise((resolve) => {
      if (!navigator.geolocation) return resolve(null);
      navigator.geolocation.getCurrentPosition(
        (pos) =>
          resolve({
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            precisao_m: pos.coords.accuracy,
          }),
        () => resolve(null),
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }
      );
    });
  }

  // ── Localização (link para mapa) ──────────────────────────
  function mapsUrl(loc) {
    if (!loc || loc.lat == null || loc.lng == null) return null;
    return `https://www.google.com/maps?q=${loc.lat},${loc.lng}`;
  }
  function pinHtml(loc) {
    const url = mapsUrl(loc);
    return url
      ? ` <a href="${url}" target="_blank" rel="noopener" class="loc-pin" title="Ver localização no mapa">📍</a>`
      : ` <span class="loc-pin loc-pin-none" title="Localização não disponível para este registro">📍</span>`;
  }

  // ── Agrupamento de registros por dia ─────────────────────
  function buildRegistrosByDay(registrosAsc) {
    const map = {};
    for (const r of registrosAsc) {
      const key = dateKeySP(r.registrado_em);
      if (!map[key]) map[key] = { pares: [], totalHoras: 0, aberto: false, _pendente: null };
      const day = map[key];
      if (r.tipo === "entrada") {
        day._pendente = { ts: r.registrado_em, loc: { lat: r.lat, lng: r.lng } };
        day.aberto = true;
      } else if (day._pendente) {
        const horas = (new Date(r.registrado_em) - new Date(day._pendente.ts)) / 3600000;
        day.pares.push({
          entradaTxt: timeSP(day._pendente.ts),
          entradaLoc: day._pendente.loc,
          saidaTxt: timeSP(r.registrado_em),
          saidaLoc: { lat: r.lat, lng: r.lng },
          horas,
        });
        day.totalHoras += horas;
        day._pendente = null;
        day.aberto = false;
      }
    }
    return map;
  }

  function buildDailyRows(inicioKey, fimKey, registrosByDay, faltasByDate) {
    const rows = [];
    const todayKey = todayKeySP();
    let key = inicioKey;
    let guard = 0;
    while (key <= fimKey && guard < 2000) {
      guard++;
      const dow = weekdayOf(key);
      const isWeekend = dow === 0 || dow === 6;
      const falta = faltasByDate[key];
      const reg = registrosByDay[key];
      let situacao, badgeClass, registrosTexto, registrosHtml, horas;

      if (falta) {
        situacao = falta.justificada ? "Falta justificada" : "Falta";
        badgeClass = falta.justificada ? "badge-grey" : "badge-red";
        registrosTexto = falta.motivo ? falta.motivo : "—";
        registrosHtml = escapeHtml(registrosTexto);
        horas = 0;
      } else if (reg) {
        registrosTexto = reg.pares.length
          ? reg.pares.map((p) => `${p.entradaTxt} → ${p.saidaTxt}`).join(", ")
          : "—";
        registrosHtml = reg.pares.length
          ? reg.pares
              .map((p) => `${p.entradaTxt}${pinHtml(p.entradaLoc)} → ${p.saidaTxt}${pinHtml(p.saidaLoc)}`)
              .join(", ")
          : "—";
        if (reg.aberto) {
          registrosTexto += (reg.pares.length ? ", " : "") + "(em aberto)";
          registrosHtml +=
            (reg.pares.length ? ", " : "") +
            `(em aberto${reg._pendente ? pinHtml(reg._pendente.loc) : ""})`;
          situacao = key === todayKey ? "Em andamento" : "Pendente (sem saída)";
          badgeClass = key === todayKey ? "badge-yellow" : "badge-red";
        } else {
          situacao = "OK";
          badgeClass = "badge-green";
        }
        horas = reg.totalHoras;
      } else if (isWeekend) {
        situacao = "—";
        badgeClass = "badge-grey";
        registrosTexto = "—";
        registrosHtml = "—";
        horas = 0;
      } else {
        situacao = "Sem registro";
        badgeClass = "badge-yellow";
        registrosTexto = "—";
        registrosHtml = "—";
        horas = 0;
      }

      rows.push({ key, dataBR: fmtDateBR(key), registrosTexto, registrosHtml, horas, situacao, badgeClass });
      key = addDaysKey(key, 1);
    }
    return rows;
  }

  // ── Login ─────────────────────────────────────────────────
  async function onSubmitLogin(e) {
    e.preventDefault();
    showLoginError("");
    const raw = $("login-id").value.trim();
    const senha = $("login-senha").value;
    const email = raw.includes("@") ? raw : `ponto_${onlyDigits(raw)}@${CONFIG.EMAIL_DOMAIN}`;

    $("btn-login").disabled = true;
    $("btn-login").textContent = "Entrando…";
    try {
      const { data, error } = await sb.auth.signInWithPassword({ email, password: senha });
      if (error) {
        showLoginError("CPF/e-mail ou senha inválidos.");
        return;
      }
      await routeAfterLogin(data.session);
    } finally {
      $("btn-login").disabled = false;
      $("btn-login").textContent = "Entrar";
    }
  }

  async function routeAfterLogin(session) {
    state.session = session;
    state.user = session.user;

    const { data: adminRow } = await sb
      .from("ponto_admins")
      .select("user_id, nome")
      .eq("user_id", state.user.id)
      .maybeSingle();

    if (adminRow) {
      state.isAdmin = true;
      $("topbar-nome").textContent = adminRow.nome;
      showOnly("view-app");
      showAppSection("admin");
      await loadAdminData();
      return;
    }

    const { data: colab } = await sb
      .from("ponto_colaboradores")
      .select("*")
      .eq("id", state.user.id)
      .maybeSingle();

    if (!colab) {
      showLoginError("Essa conta não tem cadastro de colaborador. Fale com o RH.");
      await sb.auth.signOut();
      showOnly("view-login");
      return;
    }
    if (!colab.ativo) {
      showLoginError("Seu acesso foi desativado. Fale com o RH.");
      await sb.auth.signOut();
      showOnly("view-login");
      return;
    }

    state.isAdmin = false;
    state.colaborador = colab;
    $("topbar-nome").textContent = colab.nome;
    $("minha-conta-cargo").textContent = colab.cargo || "—";
    showOnly("view-app");
    showAppSection("colaborador");
    await loadColaboradorData();

    if (colab.must_change_password) abrirModalSenha(true);
  }

  async function onSair() {
    await sb.auth.signOut();
    state.session = null;
    state.user = null;
    state.isAdmin = false;
    state.colaborador = null;
    $("login-id").value = "";
    $("login-senha").value = "";
    showLoginError("");
    showOnly("view-login");
  }

  // ── Colaborador: bater ponto ──────────────────────────────
  async function carregarStatusHoje() {
    const hojeKey = todayKeySP();
    const { startISO, endISO } = boundsISO(hojeKey, hojeKey);
    const { data, error } = await sb
      .from("ponto_registros")
      .select("tipo, registrado_em")
      .eq("colaborador_id", state.user.id)
      .gte("registrado_em", startISO)
      .lte("registrado_em", endISO)
      .order("registrado_em", { ascending: true });

    const box = $("status-hoje");
    const btn = $("btn-bater-ponto");
    if (error) {
      box.textContent = "Não foi possível carregar o status de hoje.";
      btn.disabled = true;
      return;
    }
    if (!data.length) {
      box.innerHTML = "Nenhum registro hoje ainda.";
      state.proximoTipoHoje = "entrada";
      btn.textContent = "Bater entrada";
    } else {
      const ultimo = data[data.length - 1];
      const partes = data
        .map((r) => `${r.tipo === "entrada" ? "Entrada" : "Saída"} ${timeSP(r.registrado_em)}`)
        .join(" · ");
      box.innerHTML = `<strong>Hoje:</strong> ${partes}`;
      state.proximoTipoHoje = ultimo.tipo === "entrada" ? "saida" : "entrada";
      btn.textContent = state.proximoTipoHoje === "entrada" ? "Bater entrada" : "Bater saída";
    }
    btn.disabled = false;
  }

  async function onBaterPonto() {
    const btn = $("btn-bater-ponto");
    const msg = $("punch-msg");
    msg.textContent = "";
    msg.className = "msg";
    btn.disabled = true;
    btn.textContent = "Obtendo localização…";

    const loc = await getLocation();
    const tipo = state.proximoTipoHoje;

    const { error } = await sb.from("ponto_registros").insert({
      colaborador_id: state.user.id,
      tipo,
      lat: loc ? loc.lat : null,
      lng: loc ? loc.lng : null,
      precisao_m: loc ? loc.precisao_m : null,
    });

    if (error) {
      msg.textContent = "Não foi possível registrar: " + friendly(error.message);
      msg.className = "msg msg-error";
    } else {
      msg.textContent = `${tipo === "entrada" ? "Entrada" : "Saída"} registrada às ${timeSP(
        new Date().toISOString()
      )}${loc ? "" : " (sem localização — permissão negada ou indisponível)"}.`;
      msg.className = "msg msg-ok";
      await carregarStatusHoje();
      await carregarMeusRegistros();
    }
    btn.disabled = false;
  }

  async function carregarMeusRegistros() {
    const fimKey = todayKeySP();
    const inicioKey = addDaysKey(fimKey, -29);
    const { startISO, endISO } = boundsISO(inicioKey, fimKey);

    const [{ data: registros, error: e1 }, { data: faltas, error: e2 }] = await Promise.all([
      sb
        .from("ponto_registros")
        .select("tipo, registrado_em")
        .eq("colaborador_id", state.user.id)
        .gte("registrado_em", startISO)
        .lte("registrado_em", endISO)
        .order("registrado_em", { ascending: true }),
      sb
        .from("ponto_faltas")
        .select("data, motivo, justificada")
        .eq("colaborador_id", state.user.id)
        .gte("data", inicioKey)
        .lte("data", fimKey),
    ]);

    const tbody = $("tbody-meus-registros");
    if (e1 || e2) {
      tbody.innerHTML = '<tr><td colspan="4" class="table-empty">Não foi possível carregar seus registros.</td></tr>';
      return;
    }

    const byDay = buildRegistrosByDay(registros || []);
    const faltasByDate = {};
    (faltas || []).forEach((f) => (faltasByDate[f.data] = f));
    const rows = buildDailyRows(inicioKey, fimKey, byDay, faltasByDate).reverse();

    tbody.innerHTML = rows
      .map(
        (r) => `<tr>
          <td>${r.dataBR}</td>
          <td>${escapeHtml(r.registrosTexto)}</td>
          <td>${r.horas ? fmtHoras(r.horas) : "—"}</td>
          <td><span class="badge ${r.badgeClass}">${escapeHtml(r.situacao)}</span></td>
        </tr>`
      )
      .join("");
  }

  async function loadColaboradorData() {
    await carregarStatusHoje();
    await carregarMeusRegistros();
  }

  // ── Escape básico ─────────────────────────────────────────
  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[c]));
  }

  // ── Modal trocar senha ────────────────────────────────────
  function abrirModalSenha(forced) {
    state.forceChangePassword = !!forced;
    $("modal-senha-hint").textContent = forced
      ? "Este é seu primeiro acesso (ou sua senha foi redefinida pelo RH). Escolha uma nova senha para continuar."
      : "Escolha uma nova senha para acessar o sistema.";
    $("btn-cancelar-senha").hidden = !!forced;
    $("nova-senha").value = "";
    $("confirmar-senha").value = "";
    $("senha-msg").textContent = "";
    $("modal-senha").hidden = false;
  }
  function fecharModalSenha() {
    if (state.forceChangePassword) return; // não pode fechar sem trocar
    $("modal-senha").hidden = true;
  }
  async function onTrocarSenha(e) {
    e.preventDefault();
    const nova = $("nova-senha").value;
    const conf = $("confirmar-senha").value;
    const msg = $("senha-msg");
    msg.className = "msg";
    if (nova.length < 6) {
      msg.textContent = "A senha precisa ter pelo menos 6 caracteres.";
      msg.className = "msg msg-error";
      return;
    }
    if (nova !== conf) {
      msg.textContent = "As senhas não conferem.";
      msg.className = "msg msg-error";
      return;
    }
    $("btn-salvar-senha").disabled = true;
    try {
      const { error } = await sb.auth.updateUser({ password: nova });
      if (error) {
        msg.textContent = friendly(error.message);
        msg.className = "msg msg-error";
        return;
      }
      if (!state.isAdmin && state.colaborador) {
        await sb.rpc("ponto_marcar_senha_trocada");
        state.colaborador.must_change_password = false;
      }
      state.forceChangePassword = false;
      $("modal-senha").hidden = true;
    } finally {
      $("btn-salvar-senha").disabled = false;
    }
  }

  // ── Admin: prédios (referência para localização) ──────────
  async function carregarPredios() {
    const { data, error } = await sb
      .from("cm_predios")
      .select("id, nome, endereco")
      .eq("ativo", true)
      .order("nome", { ascending: true });
    state.prediosCache = error ? [] : data || [];
    const sel = $("nc-predio");
    if (sel) {
      sel.innerHTML =
        '<option value="">Selecione…</option>' +
        state.prediosCache.map((p) => `<option value="${p.id}">${escapeHtml(p.nome)}</option>`).join("");
    }
  }

  // ── Admin: colaboradores ──────────────────────────────────
  async function loadAdminData() {
    await carregarPredios();
    await carregarColaboradores();
    popularSelectsColaboradores();
    const hoje = todayKeySP();
    const inicioMes = hoje.slice(0, 8) + "01";
    $("rel-inicio").value = inicioMes;
    $("rel-fim").value = hoje;
    $("falta-data").value = hoje;
    await carregarFaltas();
  }

  async function carregarColaboradores() {
    const { data, error } = await sb
      .from("ponto_colaboradores")
      .select("*, predio:cm_predios(nome, endereco)")
      .order("nome", { ascending: true });
    const tbody = $("tbody-colaboradores");
    if (error) {
      tbody.innerHTML = '<tr><td colspan="6" class="table-empty">Não foi possível carregar os colaboradores.</td></tr>';
      return;
    }
    state.colaboradoresCache = data || [];
    if (!data.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="table-empty">Nenhum colaborador cadastrado ainda.</td></tr>';
      return;
    }
    tbody.innerHTML = data
      .map(
        (c) => `<tr>
          <td>${escapeHtml(c.nome)}</td>
          <td>${formatCPF(c.cpf)}</td>
          <td>${escapeHtml(c.cargo || "—")}</td>
          <td>${escapeHtml(c.predio?.nome || "—")}</td>
          <td><span class="badge ${c.ativo ? "badge-green" : "badge-grey"}">${c.ativo ? "Ativo" : "Inativo"}</span></td>
          <td class="actions-cell">
            <button class="btn btn-secondary btn-small" data-action="reset" data-id="${c.id}">Resetar senha</button>
            <button class="btn ${c.ativo ? "btn-danger" : "btn-secondary"} btn-small" data-action="toggle" data-id="${c.id}">${c.ativo ? "Desativar" : "Reativar"}</button>
          </td>
        </tr>`
      )
      .join("");
  }

  function popularSelectsColaboradores() {
    const relSel = $("rel-colaborador");
    const faltaSel = $("falta-colaborador");
    const opts = state.colaboradoresCache
      .map((c) => `<option value="${c.id}">${escapeHtml(c.nome)}${c.ativo ? "" : " (inativo)"}</option>`)
      .join("");
    relSel.innerHTML = '<option value="">Todos</option>' + opts;
    faltaSel.innerHTML = opts || '<option value="">Nenhum colaborador cadastrado</option>';
  }

  async function onNovoColaborador(e) {
    e.preventDefault();
    const msg = $("novo-colaborador-msg");
    msg.className = "msg";
    msg.textContent = "";
    const nome = $("nc-nome").value.trim();
    const cpf = onlyDigits($("nc-cpf").value);
    const cargo = $("nc-cargo").value.trim();
    const predio_id = $("nc-predio").value || null;

    if (!isValidCPF(cpf)) {
      msg.textContent = "CPF inválido. Confira os números digitados.";
      msg.className = "msg msg-error";
      return;
    }

    $("btn-novo-colaborador").disabled = true;
    try {
      const data = await invokeFn("ponto-criar-colaborador", { nome, cpf, cargo, predio_id });
      msg.textContent = `Colaborador cadastrado! Login: CPF (${formatCPF(cpf)}) · Senha inicial: ${data.senha_inicial}. Informe isso ao colaborador — ele deverá trocar a senha no primeiro acesso.`;
      msg.className = "msg msg-ok";
      $("form-novo-colaborador").reset();
      await carregarColaboradores();
      popularSelectsColaboradores();
    } catch (err) {
      msg.textContent = err.message;
      msg.className = "msg msg-error";
    } finally {
      $("btn-novo-colaborador").disabled = false;
    }
  }

  async function onClickColaboradoresTable(e) {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const id = btn.dataset.id;
    const colab = state.colaboradoresCache.find((c) => c.id === id);
    if (!colab) return;

    if (btn.dataset.action === "toggle") {
      const novoAtivo = !colab.ativo;
      if (!confirm(`${novoAtivo ? "Reativar" : "Desativar"} ${colab.nome}?`)) return;
      btn.disabled = true;
      const { error } = await sb.from("ponto_colaboradores").update({ ativo: novoAtivo }).eq("id", id);
      if (error) alert("Erro ao atualizar: " + friendly(error.message));
      await carregarColaboradores();
      popularSelectsColaboradores();
    } else if (btn.dataset.action === "reset") {
      if (!confirm(`Resetar a senha de ${colab.nome} para o CPF novamente?`)) return;
      btn.disabled = true;
      try {
        const data = await invokeFn("ponto-resetar-senha", { colaborador_id: id });
        alert(`Senha redefinida. Nova senha inicial: ${data.senha_inicial}\nInforme ao colaborador — ele deverá trocar a senha no próximo acesso.`);
        await carregarColaboradores();
      } catch (err) {
        alert(err.message);
      } finally {
        btn.disabled = false;
      }
    }
  }

  // ── Admin: relatório ──────────────────────────────────────
  async function onGerarRelatorio() {
    const colabId = $("rel-colaborador").value;
    const inicio = $("rel-inicio").value;
    const fim = $("rel-fim").value;
    const thead = $("thead-relatorio");
    const tbody = $("tbody-relatorio");
    if (!inicio || !fim) {
      tbody.innerHTML = '<tr><td class="table-empty">Escolha o período.</td></tr>';
      return;
    }
    tbody.innerHTML = '<tr><td class="table-empty">Gerando…</td></tr>';
    const { startISO, endISO } = boundsISO(inicio, fim);

    if (colabId) {
      const colab = state.colaboradoresCache.find((c) => c.id === colabId);
      const predioInfo = $("rel-predio-info");
      if (predioInfo) {
        predioInfo.textContent = colab?.predio
          ? `Prédio: ${colab.predio.nome}${colab.predio.endereco ? " — " + colab.predio.endereco : " (endereço não cadastrado)"}`
          : "Prédio: não informado no cadastro deste colaborador.";
      }
      const [{ data: registros, error: e1 }, { data: faltas, error: e2 }] = await Promise.all([
        sb
          .from("ponto_registros")
          .select("tipo, registrado_em, lat, lng")
          .eq("colaborador_id", colabId)
          .gte("registrado_em", startISO)
          .lte("registrado_em", endISO)
          .order("registrado_em", { ascending: true }),
        sb.from("ponto_faltas").select("data, motivo, justificada").eq("colaborador_id", colabId).gte("data", inicio).lte("data", fim),
      ]);
      if (e1 || e2) {
        tbody.innerHTML = '<tr><td class="table-empty">Não foi possível gerar o relatório.</td></tr>';
        return;
      }
      const byDay = buildRegistrosByDay(registros || []);
      const faltasByDate = {};
      (faltas || []).forEach((f) => (faltasByDate[f.data] = f));
      const rows = buildDailyRows(inicio, fim, byDay, faltasByDate);
      const totalHoras = rows.reduce((s, r) => s + (typeof r.horas === "number" ? r.horas : 0), 0);

      thead.innerHTML = "<tr><th>Data</th><th>Registros</th><th>Horas</th><th>Situação</th></tr>";
      tbody.innerHTML =
        rows
          .map(
            (r) => `<tr>
              <td>${r.dataBR}</td>
              <td>${r.registrosHtml}</td>
              <td>${r.horas ? fmtHoras(r.horas) : "—"}</td>
              <td><span class="badge ${r.badgeClass}">${escapeHtml(r.situacao)}</span></td>
            </tr>`
          )
          .join("") +
        `<tr><td colspan="2"><strong>Total do período</strong></td><td><strong>${fmtHoras(totalHoras)}</strong></td><td></td></tr>`;

      state.lastReport = {
        mode: "detail",
        filename: `ponto_${colab ? colab.nome.replace(/\s+/g, "_") : "colaborador"}_${inicio}_a_${fim}.xlsx`,
        headers: ["Data", "Registros", "Horas", "Situação"],
        rows: rows.map((r) => ({
          Data: r.dataBR,
          Registros: r.registrosTexto,
          Horas: r.horas ? fmtHoras(r.horas) : "",
          "Situação": r.situacao,
        })),
      };
    } else {
      const predioInfo = $("rel-predio-info");
      if (predioInfo) predioInfo.textContent = "";
      const [{ data: registros, error: e1 }, { data: faltas, error: e2 }] = await Promise.all([
        sb
          .from("ponto_registros")
          .select("colaborador_id, tipo, registrado_em")
          .gte("registrado_em", startISO)
          .lte("registrado_em", endISO)
          .order("registrado_em", { ascending: true }),
        sb.from("ponto_faltas").select("colaborador_id, data, motivo, justificada").gte("data", inicio).lte("data", fim),
      ]);
      if (e1 || e2) {
        tbody.innerHTML = '<tr><td class="table-empty">Não foi possível gerar o relatório.</td></tr>';
        return;
      }
      const rows = state.colaboradoresCache.map((c) => {
        const regsC = (registros || []).filter((r) => r.colaborador_id === c.id);
        const faltasC = (faltas || []).filter((f) => f.colaborador_id === c.id);
        const byDay = buildRegistrosByDay(regsC);
        const faltasByDate = {};
        faltasC.forEach((f) => (faltasByDate[f.data] = f));
        const daily = buildDailyRows(inicio, fim, byDay, faltasByDate);
        const totalHoras = daily.reduce((s, d) => s + (typeof d.horas === "number" ? d.horas : 0), 0);
        return {
          nome: c.nome,
          cpf: formatCPF(c.cpf),
          totalHoras,
          diasTrabalhados: daily.filter((d) => d.situacao === "OK").length,
          faltas: daily.filter((d) => d.situacao === "Falta").length,
          faltasJustificadas: daily.filter((d) => d.situacao === "Falta justificada").length,
          semRegistro: daily.filter((d) => d.situacao === "Sem registro").length,
          pendentes: daily.filter((d) => d.situacao === "Pendente (sem saída)").length,
        };
      });

      thead.innerHTML =
        "<tr><th>Colaborador</th><th>CPF</th><th>Total de horas</th><th>Dias c/ registro</th><th>Faltas</th><th>Faltas justif.</th><th>Sem registro</th><th>Pendentes</th></tr>";
      tbody.innerHTML = rows.length
        ? rows
            .map(
              (r) => `<tr>
                <td>${escapeHtml(r.nome)}</td>
                <td>${r.cpf}</td>
                <td>${fmtHoras(r.totalHoras)}</td>
                <td>${r.diasTrabalhados}</td>
                <td>${r.faltas ? `<span class="badge badge-red">${r.faltas}</span>` : "0"}</td>
                <td>${r.faltasJustificadas || 0}</td>
                <td>${r.semRegistro ? `<span class="badge badge-yellow">${r.semRegistro}</span>` : "0"}</td>
                <td>${r.pendentes || 0}</td>
              </tr>`
            )
            .join("")
        : '<tr><td colspan="8" class="table-empty">Nenhum colaborador cadastrado.</td></tr>';

      state.lastReport = {
        mode: "summary",
        filename: `ponto_resumo_${inicio}_a_${fim}.xlsx`,
        headers: null,
        rows: rows.map((r) => ({
          Colaborador: r.nome,
          CPF: r.cpf,
          "Total de horas": fmtHoras(r.totalHoras),
          "Dias com registro": r.diasTrabalhados,
          Faltas: r.faltas,
          "Faltas justificadas": r.faltasJustificadas,
          "Sem registro": r.semRegistro,
          "Pendentes (sem saída)": r.pendentes,
        })),
      };
    }
  }

  function onExportarRelatorio() {
    if (!state.lastReport || !state.lastReport.rows.length) {
      alert("Gere o relatório antes de exportar.");
      return;
    }
    const ws = window.XLSX.utils.json_to_sheet(state.lastReport.rows);
    const wb = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(wb, ws, "Relatório");
    window.XLSX.writeFile(wb, state.lastReport.filename);
  }

  // ── Admin: faltas ─────────────────────────────────────────
  async function onRegistrarFalta(e) {
    e.preventDefault();
    const msg = $("falta-msg");
    msg.className = "msg";
    const colaborador_id = $("falta-colaborador").value;
    const data = $("falta-data").value;
    const motivo = $("falta-motivo").value.trim() || null;
    const justificada = $("falta-justificada").checked;

    if (!colaborador_id) {
      msg.textContent = "Selecione um colaborador.";
      msg.className = "msg msg-error";
      return;
    }

    $("btn-registrar-falta").disabled = true;
    const { error } = await sb.from("ponto_faltas").insert({
      colaborador_id,
      data,
      motivo,
      justificada,
      criado_por: state.user.id,
    });
    $("btn-registrar-falta").disabled = false;

    if (error) {
      msg.textContent = error.code === "23505" ? "Já existe uma falta registrada para esse colaborador nessa data." : friendly(error.message);
      msg.className = "msg msg-error";
      return;
    }
    msg.textContent = "Falta registrada.";
    msg.className = "msg msg-ok";
    $("form-falta").reset();
    $("falta-data").value = todayKeySP();
    await carregarFaltas();
  }

  async function carregarFaltas() {
    const { data, error } = await sb
      .from("ponto_faltas")
      .select("id, colaborador_id, data, motivo, justificada")
      .order("data", { ascending: false })
      .limit(300);
    const tbody = $("tbody-faltas");
    if (error) {
      tbody.innerHTML = '<tr><td colspan="5" class="table-empty">Não foi possível carregar as faltas.</td></tr>';
      return;
    }
    if (!data.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="table-empty">Nenhuma falta registrada.</td></tr>';
      return;
    }
    const nomeById = {};
    state.colaboradoresCache.forEach((c) => (nomeById[c.id] = c.nome));
    tbody.innerHTML = data
      .map(
        (f) => `<tr>
          <td>${escapeHtml(nomeById[f.colaborador_id] || "—")}</td>
          <td>${fmtDateBR(f.data)}</td>
          <td>${escapeHtml(f.motivo || "—")}</td>
          <td><span class="badge ${f.justificada ? "badge-grey" : "badge-red"}">${f.justificada ? "Justificada" : "Não justificada"}</span></td>
          <td><button class="btn btn-danger btn-small" data-action="del-falta" data-id="${f.id}">Remover</button></td>
        </tr>`
      )
      .join("");
  }

  async function onClickFaltasTable(e) {
    const btn = e.target.closest('button[data-action="del-falta"]');
    if (!btn) return;
    if (!confirm("Remover essa falta?")) return;
    btn.disabled = true;
    const { error } = await sb.from("ponto_faltas").delete().eq("id", btn.dataset.id);
    if (error) alert("Erro ao remover: " + friendly(error.message));
    await carregarFaltas();
  }

  // ── Abas (tabs) ───────────────────────────────────────────
  function onClickTab(e) {
    const btn = e.target.closest(".tab-btn");
    if (!btn) return;
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b === btn));
    document.querySelectorAll(".tab-pane").forEach((p) => (p.hidden = p.id !== btn.dataset.tab));
  }

  // ── Inicialização ─────────────────────────────────────────
  function wireEvents() {
    $("form-login").addEventListener("submit", onSubmitLogin);
    $("btn-sair").addEventListener("click", onSair);
    $("btn-bater-ponto").addEventListener("click", onBaterPonto);
    $("btn-abrir-trocar-senha").addEventListener("click", () => abrirModalSenha(false));
    $("btn-cancelar-senha").addEventListener("click", fecharModalSenha);
    $("form-trocar-senha").addEventListener("submit", onTrocarSenha);
    $("form-novo-colaborador").addEventListener("submit", onNovoColaborador);
    $("tbody-colaboradores").addEventListener("click", onClickColaboradoresTable);
    $("btn-gerar-relatorio").addEventListener("click", onGerarRelatorio);
    $("btn-exportar-relatorio").addEventListener("click", onExportarRelatorio);
    $("form-falta").addEventListener("submit", onRegistrarFalta);
    $("tbody-faltas").addEventListener("click", onClickFaltasTable);
    document.querySelectorAll(".tab-btn").forEach((b) => b.addEventListener("click", onClickTab));
  }

  async function init() {
    wireEvents();
    const {
      data: { session },
    } = await sb.auth.getSession();
    if (session) {
      await routeAfterLogin(session);
    } else {
      showOnly("view-login");
    }

    sb.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") {
        showOnly("view-login");
      }
    });
  }

  init();
})();
