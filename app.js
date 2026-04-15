/**
 * Work Management Assistant - Professional Edition
 * Enterprise-Grade Workforce Planning System
 */

(function() {
    'use strict';

    // ==================== CONFIG ====================
    const CONFIG = {
        storage: {
            people: 'wma_people',
            tasks: 'wma_tasks',
            settings: 'wma_settings',
            seenTutorial: 'wma_seen_tutorial'
        },
        api: 'https://openrouter.ai/api/v1/chat/completions',
        defaults: {
            capacity: 40,
            monthlyCapacity: 160,
            efficiency: 1.0
        }
    };

    // ==================== STATE ====================
    let state = {
        people: JSON.parse(localStorage.getItem(CONFIG.storage.people)) || [],
        tasks: JSON.parse(localStorage.getItem(CONFIG.storage.tasks)) || [],
        settings: JSON.parse(localStorage.getItem(CONFIG.storage.settings)) || { apiKey: '', model: 'anthropic/claude-opus-4.6-20251114' }
    };

    let searchTerm = '';
    let UI = {};

    // ==================== UTILITIES ====================
    const $ = (s) => document.querySelector(s);
    const $$ = (s) => document.querySelectorAll(s);
    const genId = () => Date.now().toString(36) + Math.random().toString(36).substr(2);

    const save = () => {
        localStorage.setItem(CONFIG.storage.people, JSON.stringify(state.people));
        localStorage.setItem(CONFIG.storage.tasks, JSON.stringify(state.tasks));
        localStorage.setItem(CONFIG.storage.settings, JSON.stringify(state.settings));
        render();
    };

    const loadState = () => {
        state.people = JSON.parse(localStorage.getItem(CONFIG.storage.people)) || [];
        state.tasks = JSON.parse(localStorage.getItem(CONFIG.storage.tasks)) || [];
    };

    // ==================== DATE HELPERS ====================
    const formatDate = (d) => d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
    
    const daysUntil = (d) => {
        if (!d) return null;
        return Math.ceil((new Date(d) - new Date()) / (1000 * 60 * 60 * 24));
    };

    const today = () => new Date().toISOString().split('T')[0];

    // ==================== TASK ANALYSIS ====================
    const getTaskLoad = (task) => {
        if (task.completed) return { daily: 0, weekly: 0, monthly: 0, total: task.hours };
        
        const start = task.assignmentDate ? new Date(task.assignmentDate) : new Date();
        const end = task.dueDate ? new Date(task.dueDate) : new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
        
        const days = Math.max(1, Math.ceil((end - start) / (1000 * 60 * 60 * 24)));
        const rate = (task.hours || 0) / days;
        
        return {
            daily: rate,
            weekly: Math.min(task.hours, rate * 7),
            monthly: Math.min(task.hours, rate * 30),
            total: task.hours
        };
    };

    const getPersonLoad = (personId, mode = 'weekly') => {
        return state.tasks
            .filter(t => t.assignedToId === personId && !t.completed)
            .reduce((sum, t) => sum + getTaskLoad(t)[mode], 0);
    };

    const getPersonStats = (personId) => {
        const p = state.people.find(x => x.id === personId);
        if (!p) return null;
        
        const cap = parseFloat(p.capacity) || CONFIG.defaults.capacity;
        const mCap = parseFloat(p.monthlyCapacity) || CONFIG.defaults.monthlyCapacity;
        const w = getPersonLoad(personId, 'weekly');
        const m = getPersonLoad(personId, 'monthly');
        
        return {
            weekly: w,
            monthly: m,
            capacity: cap,
            monthlyCapacity: mCap,
            weekUtil: (w / cap) * 100,
            monthUtil: (m / mCap) * 100,
            weekRemaining: cap - w,
            monthRemaining: mCap - m
        };
    };

    // ==================== SUGGESTION ENGINE ====================
    const scorePerson = (person, task) => {
        let score = 0;
        const stats = getPersonStats(person.id);
        const reqSkills = (task.skills || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
        const hasSkills = (person.skills || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
        const avoidTraits = (task.avoidTraits || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
        const hasTraits = (person.traits || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
        
        // Skill match (0-40)
        if (reqSkills.length) {
            const matches = reqSkills.filter(s => hasSkills.some(hs => hs.includes(s))).length;
            score += (matches / reqSkills.length) * 40;
        }
        
        // Avoid negative traits penalty
        if (avoidTraits.length) {
            const negMatches = avoidTraits.filter(t => hasTraits.some(ht => ht.includes(t))).length;
            score -= negMatches * 25;
        }
        
        // Capacity check (0-30)
        if (stats && stats.weekRemaining >= (task.hours || 0)) score += 30;
        else if (stats && stats.weekRemaining > 0) score += 10;
        
        // Due date urgency (0-20)
        if (task.dueDate) {
            const days = daysUntil(task.dueDate);
            if (days !== null) {
                if (days < 0) score += 20;
                else if (days <= 2) score += 15;
                else if (days <= 7) score += 10;
                else score += 5;
            }
        }
        
        // Manager override
        const ov = person.statusOverride;
        if (ov === 'available') { score += 35; }
        else if (ov === 'busy') { score -= 25; }
        else if (ov === 'away') { score = -100; }
        
        return Math.max(0, Math.min(100, Math.round(score)));
    };

    const getSuggestions = (task) => {
        if (!state.people.length) return [];
        
        return state.people.map(p => {
            const stats = getPersonStats(p.id);
            const score = scorePerson(p, task);
            
            let status, statusClass;
            if (stats.weekRemaining < 1) { status = 'At Capacity'; statusClass = 'full'; }
            else if (stats.weekRemaining < 10) { status = 'Limited'; statusClass = 'limited'; }
            else { status = 'Available'; statusClass = 'available'; }
            
            if (p.statusOverride === 'available') { status = 'Forced Available'; statusClass = 'available'; }
            else if (p.statusOverride === 'busy') { status = 'Forced Busy'; statusClass = 'busy'; }
            else if (p.statusOverride === 'away') { status = 'Away'; statusClass = 'away'; }
            
            return { person: p, score, status, statusClass, stats };
        }).sort((a, b) => b.score - a.score);
    };

    const getAISuggestions = async (task) => {
        if (!state.settings.apiKey) return null;
        
        const team = state.people.map(p => 
            `${p.name}: ${p.skills} (${p.efficiency}x, ${p.capacity}h/wk)`
        ).join('\n');
        
        const systemPrompt = `You are a senior workforce manager. Recommend the best person for this task:

Task: ${task.desc}
Skills: ${task.skills}
Hours: ${task.hours}
Due: ${task.dueDate}
Avoid traits: ${task.avoidTraits || 'none'}

Team:
${team}

Reply ONLY with JSON array: [{"name": "Name", "reason": "Brief reason", "score": 85}]`;

        try {
            const res = await fetch(CONFIG.api, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${state.settings.apiKey}`,
                    'HTTP-Referer': location.origin,
                    'X-Title': 'WMA'
                },
                body: JSON.stringify({
                    model: state.settings.model,
                    max_tokens: 400,
                    messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: 'Recommend.' }]
                })
            });
            
            const data = await res.json();
            const match = data.choices?.[0]?.message?.content?.match(/\[[\s\S]*\]/);
            return match ? JSON.parse(match[0]) : null;
        } catch (e) {
            console.error('AI Error:', e);
            return null;
        }
    };

    // ==================== UI ACTIONS ====================
    const openModal = (person = null) => {
        const modal = $('#person-modal');
        const form = $('#person-form');
        
        if (person) {
            $('#modal-title').textContent = 'Edit Team Member';
            $('#person-id').value = person.id;
            $('#p-name').value = person.name || '';
            $('#p-skills').value = person.skills || '';
            $('#p-traits').value = person.traits || '';
            $('#p-efficiency').value = person.efficiency || 1;
            $('#p-capacity').value = person.capacity || 40;
            $('#p-monthly-capacity').value = person.monthlyCapacity || 160;
            $('#p-status-override').value = person.statusOverride || 'auto';
            $('#p-notes').value = person.notes || '';
        } else {
            $('#modal-title').textContent = 'Add Team Member';
            form.reset();
            $('#person-id').value = '';
            $('#p-efficiency').value = 1;
            $('#p-capacity').value = 40;
            $('#p-monthly-capacity').value = 160;
        }
        
        modal.classList.add('active');
    };

    const closeModal = () => {
        $$('.modal').forEach(m => m.classList.remove('active'));
    };

    const deletePerson = (id) => {
        state.tasks = state.tasks.map(t => 
            t.assignedToId === id ? { ...t, assignedToId: null, assignedToName: null } : t
        );
        state.people = state.people.filter(p => p.id !== id);
        save();
    };

    const deleteTask = (id) => {
        state.tasks = state.tasks.filter(t => t.id !== id);
        save();
        
        // Show notification
        const toast = $('#delete-toast');
        if (toast) {
            toast.classList.add('show');
            setTimeout(() => toast.classList.remove('show'), 3000);
        }
    };

    const completeTask = (id) => {
        state.tasks = state.tasks.map(t => t.id === id ? { ...t, completed: !t.completed } : t);
        save();
    };

    const assignTask = (pid, desc, hours, due, skills) => {
        const person = state.people.find(p => p.id === pid);
        if (!person) return;
        
        state.tasks.unshift({
            id: genId(),
            desc, skills, hours: parseFloat(hours), dueDate: due,
            priority: $('#task-priority')?.value || 'medium',
            assignmentDate: new Date().toISOString(),
            assignedToId: person.id,
            assignedToName: person.name,
            timestamp: new Date().toISOString(),
            completed: false
        });
        
        $('#task-form')?.reset();
        $('#suggestion-container').innerHTML = '';
        $('#suggestion-container').style.display = 'none';
        save();
    };

    const reAssign = (id) => {
        const task = state.tasks.find(t => t.id === id);
        if (!task) return;
        
        $('#task-desc').value = task.desc;
        $('#task-skills').value = task.skills || '';
        $('#task-avoid-traits').value = task.avoidTraits || '';
        $('#task-est-hours').value = task.hours;
        $('#task-due-date').value = task.dueDate || '';
        
        window.scrollTo({ top: 0, behavior: 'smooth' });
    };

    const dismissNotify = (id) => {
        state.tasks = state.tasks.filter(t => t.id !== id);
        save();
    };

    const dismissAllNotifies = () => {
        state.tasks = state.tasks.filter(t => t.assignedToId !== null || t.completed);
        save();
    };

    // ==================== EXPORT/IMPORT ====================
    const exportData = () => {
        const data = { version: '2.0', date: new Date().toISOString(), state, settings: state.settings };
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `wma_backup_${today()}.json`;
        a.click();
    };

    const importData = (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        
        const reader = new FileReader();
        reader.onload = (ev) => {
            try {
                const data = JSON.parse(ev.target.result);
                if (data.state) { state = { ...state, ...data.state }; save(); }
                if (data.settings) { state.settings = { ...state.settings, ...data.settings }; save(); }
                alert('Data restored successfully!');
                location.reload();
            } catch (err) {
                alert('Import failed: ' + err.message);
            }
        };
        reader.readAsText(file);
    };

    // ==================== RENDERING ====================
    const render = () => {
        renderStats();
        renderTeam();
        renderTasks();
        renderNotifications();
        renderInsights();
    };

    const renderStats = () => {
        const totalCap = state.people.reduce((s, p) => s + (parseFloat(p.capacity) || 40), 0);
        const totalUsed = state.people.reduce((s, p) => s + getPersonLoad(p.id), 0);
        const monthly = state.people.reduce((s, p) => s + getPersonLoad(p.id, 'monthly'), 0);
        const unassigned = state.tasks.filter(t => !t.assignedToId && !t.completed).length;
        const util = totalCap ? Math.round((totalUsed / totalCap) * 100) : 0;
        
        if ($('#stat-capacity')) $('#stat-capacity').textContent = `${totalCap}h`;
        if ($('#stat-utilization')) {
            $('#stat-utilization').textContent = `${util}%`;
            $('#stat-utilization').className = `stat-value ${util > 90 ? 'danger' : util > 70 ? 'warning' : 'highlight'}`;
        }
        if ($('#stat-monthly')) $('#stat-monthly').textContent = `${Math.round(monthly)}h`;
        if ($('#stat-unassigned')) $('#stat-unassigned').textContent = unassigned;
    };

    const renderTeam = () => {
        const grid = $('#people-grid');
        const count = $('#people-count');
        
        if (!grid || !count) return;
        
        count.textContent = `${state.people.length} Team Member${state.people.length !== 1 ? 's' : ''}`;
        
        if (!state.people.length) {
            grid.innerHTML = `
                <div class="empty-state">
                    <i class="ph ph-users-three"></i>
                    <h3>No Team Members Yet</h3>
                    <p>Click "Add Member" to create your first team member</p>
                </div>
            `;
            return;
        }
        
        let people = [...state.people];
        
        if (searchTerm) {
            const t = searchTerm.toLowerCase();
            people = people.filter(p => 
                p.name?.toLowerCase().includes(t) ||
                p.skills?.toLowerCase().includes(t) ||
                p.traits?.toLowerCase().includes(t)
            );
        }
        
        people.sort((a, b) => {
            const ua = getPersonLoad(a.id) / (parseFloat(a.capacity) || 40);
            const ub = getPersonLoad(b.id) / (parseFloat(b.capacity) || 40);
            return ua - ub;
        });
        
        grid.innerHTML = people.map(p => {
            const stats = getPersonStats(p.id);
            const loadClass = stats.weekRemaining < 1 ? 'full' : stats.weekRemaining < 10 ? 'limited' : 'available';
            const loadText = stats.weekRemaining < 1 ? 'At Capacity' : stats.weekRemaining < 10 ? 'Limited' : 'Available';
            const override = p.statusOverride;
            
            return `
                <div class="member-card">
                    <div class="member-header">
                        <div>
                            <div class="member-name">${p.name}</div>
                            <div class="member efficiency">${p.efficiency || 1}x efficiency</div>
                        </div>
                        <div class="member-actions">
                            <button class="btn-icon" onclick="app.editPerson('${p.id}')" title="Edit">
                                <i class="ph ph-pencil-simple"></i>
                            </button>
                            <button class="btn-icon danger" onclick="app.deletePerson('${p.id}')" title="Remove">
                                <i class="ph ph-trash"></i>
                            </button>
                        </div>
                    </div>
                    
                    <div class="load-progress">
                        <div class="progress-bar">
                            <div class="progress-fill ${loadClass}" style="width: ${Math.min(100, stats.weekUtil)}%"></div>
                        </div>
                        <div class="progress-labels">
                            <span>${Math.round(stats.weekly)}h / ${stats.capacity}h</span>
                            <span>${Math.round(stats.monthly)}h / ${stats.monthlyCapacity}h monthly</span>
                        </div>
                    </div>
                    
                    <div class="member-badges">
                        <span class="badge ${loadClass}">${loadText}</span>
                        ${override !== 'auto' ? `<span class="badge override">${override.toUpperCase()}</span>` : ''}
                        ${(p.skills || '').split(',').filter(Boolean).map(s => `<span class="badge skill">${s.trim()}</span>`).join('')}
                        ${(p.traits || '').split(',').filter(Boolean).map(t => `<span class="badge trait">${t.trim()}</span>`).join('')}
                    </div>
                    
                    ${p.notes ? `<div class="member-notes">${p.notes}</div>` : ''}
                </div>
            `;
        }).join('');
    };

    const renderTasks = () => {
        const container = $('#task-history');
        if (!container) return;
        
        const tasks = state.tasks.filter(t => t.assignedToId);
        
        if (!tasks.length) {
            container.innerHTML = `
                <div class="empty-list">
                    <i class="ph ph-clipboard-text"></i>
                    <p>No Active Assignments</p>
                </div>
            `;
            return;
        }
        
        container.innerHTML = tasks.slice(0, 20).map(t => {
            const load = getTaskLoad(t);
            const days = daysUntil(t.dueDate);
            const overdue = t.dueDate && days < 0 && !t.completed;
            
            return `
                <div class="task-item ${t.completed ? 'completed' : ''} ${overdue ? 'overdue' : ''}">
                    <div class="task-info">
                        <div class="task-priority priority-${t.priority || 'medium'}">${(t.priority || 'MED').toUpperCase()}</div>
                        <div class="task-desc">${t.desc}</div>
                        <div class="task-meta">
                            <span><i class="ph ph-user"></i> ${t.assignedToName || 'Unassigned'}</span>
                            <span><i class="ph ph-clock"></i> ${load.weekly.toFixed(1)}h/wk (${load.total}h total)</span>
                            <span class="${overdue ? 'danger' : days <= 2 ? 'warning' : ''}">
                                <i class="ph ph-calendar"></i> ${formatDate(t.dueDate)} ${days !== null ? (days < 0 ? 'OVERDUE' : `${days}d left`) : ''}
                            </span>
                        </div>
                    </div>
                    <div class="task-actions">
                        <button class="btn-complete" onclick="app.completeTask('${t.id}')">
                            ${t.completed ? '<i class="ph ph-arrow-ccw"></i>' : '<i class="ph ph-check"></i>'}
                        </button>
                        <button class="btn-icon danger" onclick="app.deleteTask('${t.id}')" title="Delete">
                            <i class="ph ph-trash"></i>
                        </button>
                    </div>
                </div>
            `;
        }).join('');
    };

    const renderNotifications = () => {
        const section = $('#notification-section');
        const list = $('#reassignment-list');
        const count = $('#notif-count');
        
        if (!section || !list || !count) return;
        
        const pending = state.tasks.filter(t => !t.assignedToId && !t.completed);
        
        if (!pending.length) {
            section.style.display = 'none';
            return;
        }
        
        section.style.display = 'block';
        count.textContent = pending.length;
        
        list.innerHTML = `
            <button class="btn-clear-all" onclick="app.dismissAllNotifies()">
                <i class="ph ph-trash"></i> Clear All
            </button>
        ` + pending.map(t => `
            <div class="notify-card">
                <div class="notify-content">
                    <div class="notify-title">${t.desc}</div>
                    <div class="notify-meta">${t.hours}h • Due: ${formatDate(t.dueDate)}</div>
                    <button class="btn-reassign" onclick="app.reAssign('${t.id}')">Reassign</button>
                </div>
                <button class="btn-dismiss" onclick="app.dismissNotify('${t.id}')" title="Dismiss">
                    <i class="ph ph-x"></i>
                </button>
            </div>
        `).join('');
    };

    const renderInsights = () => {
        const container = $('#manager-insights');
        if (!container) return;
        
        const insights = [];
        
        // Overload warnings
        state.people.forEach(p => {
            const stats = getPersonStats(p.id);
            if (stats.weekUtil > 100) {
                insights.push({ type: 'danger', icon: 'ph-flame', text: `${p.name} is overloaded (${Math.round(stats.weekUtil)}%)` });
            }
        });
        
        // Overdue tasks
        state.tasks.filter(t => t.dueDate && daysUntil(t.dueDate) < 0 && !t.completed).forEach(t => {
            insights.push({ type: 'warning', icon: 'ph-warning', text: `"${t.desc}" is overdue` });
        });
        
        // Available resources
        const available = state.people.find(p => {
            const stats = getPersonStats(p.id);
            return stats && stats.weekUtil < 50;
        });
        
        if (available) {
            insights.push({ type: 'success', icon: 'ph-user-plus', text: `${available.name} has capacity available` });
        }
        
        // Unassigned tasks count
        const unassigned = state.tasks.filter(t => !t.assignedToId && !t.completed).length;
        if (unassigned > 0) {
            insights.push({ type: 'warning', icon: 'ph-clipboard', text: `${unassigned} task${unassigned > 1 ? 's' : ''} need${unassigned === 1 ? 's' : ''} assignment` });
        }
        
        if (!insights.length) {
            container.style.display = 'none';
            return;
        }
        
        container.style.display = 'block';
        container.innerHTML = insights.map(i => `
            <div class="insight ${i.type}">
                <i class="ph ${i.icon}"></i>
                <span>${i.text}</span>
            </div>
        `).join('');
    };

    const renderSuggestions = (suggestions, task, isAI = false) => {
        const container = $('#suggestion-container');
        if (!container || !suggestions.length) {
            if (container) container.style.display = 'none';
            return;
        }
        
        container.innerHTML = `
            <div class="suggestions-panel">
                <div class="suggestions-title">Recommended Assignees</div>
                <div class="suggestions-list">
                    ${suggestions.map((s, i) => `
                        <div class="suggestion ${i === 0 ? 'top' : ''}">
                            <div class="suggestion-rank">#${i + 1}</div>
                            <div class="suggestion-body">
                                <div class="suggestion-name">
                                    ${s.person.name}
                                    ${i === 0 ? '<span class="best">BEST MATCH</span>' : ''}
                                    ${isAI && s.reason ? '<span class="ai">AI</span>' : ''}
                                </div>
                                ${s.reason ? `<div class="suggestion-reason">${s.reason}</div>` : ''}
                                <div class="suggestion-meta">
                                    <span class="score">${s.score}% Match</span>
                                    <span class="status ${s.statusClass}">${s.status}</span>
                                </div>
                            </div>
                            <button class="btn-assign" onclick="app.assignTask('${s.person.id}', '${task.desc.replace(/'/g, "\\'")}', '${task.hours}', '${task.dueDate}', '${task.skills.replace(/'/g, "\\'")}')">
                                Assign
                            </button>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
        
        container.style.display = 'block';
    };

    // ==================== TUTORIAL ====================
    const showTutorial = () => {
        if (localStorage.getItem(CONFIG.storage.seenTutorial)) return;
        
        const modal = $('#tutorial-modal');
        if (modal) {
            modal.classList.add('active');
            localStorage.setItem(CONFIG.storage.seenTutorial, 'true');
        }
    };

    const skipTutorial = () => {
        $('#tutorial-modal')?.classList.remove('active');
    };

    // ==================== INITIALIZATION ====================
    const init = () => {
        // Cache DOM elements
        UI = {
            search: $('#global-search'),
            taskForm: $('#task-form'),
            personForm: $('#person-form'),
            personModal: $('#person-modal'),
            apiModal: $('#api-modal')
        };
        
        // Header actions
        $('#open-add-person')?.addEventListener('click', () => openModal());
        $('#close-modal')?.addEventListener('click', closeModal);
        $('#backup-data')?.addEventListener('click', exportData);
        $('#restore-trigger')?.addEventListener('click', () => $('#restore-data')?.click());
        $('#restore-data')?.addEventListener('change', importData);
        
        $('#api-settings')?.addEventListener('click', () => {
            $('#api-key').value = state.settings.apiKey || '';
            $('#api-model').value = state.settings.model || 'anthropic/claude-opus-4.6-20251114';
            $('#api-modal')?.classList.add('active');
        });
        
        $('#close-api-modal')?.addEventListener('click', closeModal);
        $('#skip-tutorial')?.addEventListener('click', skipTutorial);
        
        // Search
        UI.search?.addEventListener('input', (e) => {
            searchTerm = e.target.value;
            render();
        });
        
        // Person form
        UI.personForm?.addEventListener('submit', (e) => {
            e.preventDefault();
            const id = $('#person-id').value;
            const data = {
                id: id || genId(),
                name: $('#p-name').value,
                skills: $('#p-skills').value,
                traits: $('#p-traits').value,
                efficiency: $('#p-efficiency').value,
                capacity: $('#p-capacity').value,
                monthlyCapacity: $('#p-monthly-capacity').value,
                statusOverride: $('#p-status-override').value,
                notes: $('#p-notes').value
            };
            
            if (id) {
                state.people = state.people.map(p => p.id === id ? data : p);
            } else {
                state.people.push(data);
            }
            
            save();
            closeModal();
        });
        
        // Task form
        UI.taskForm?.addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const task = {
                desc: $('#task-desc').value,
                skills: $('#task-skills').value,
                avoidTraits: $('#task-avoid-traits').value,
                hours: $('#task-est-hours').value,
                dueDate: $('#task-due-date').value
            };
            
            if (!task.desc || !task.skills || !task.hours || !task.dueDate) {
                alert('Please fill in all required fields');
                return;
            }
            
            const btn = $('#task-form button[type="submit"]');
            btn.innerHTML = '<i class="ph ph-spinner spinning"></i> Analyzing...';
            btn.disabled = true;
            
            let suggestions = getSuggestions(task);
            
            if (state.settings.apiKey) {
                const aiResults = await getAISuggestions(task);
                if (aiResults?.length) {
                    suggestions = aiResults.map(r => {
                        const person = state.people.find(p => p.name === r.name);
                        if (!person) return null;
                        const stats = getPersonStats(person.id);
                        return {
                            person,
                            score: r.score,
                            reason: r.reason,
                            status: stats.weekRemaining >= task.hours ? 'Available' : 'At Capacity',
                            statusClass: stats.weekRemaining >= task.hours ? 'available' : 'full',
                            stats
                        };
                    }).filter(Boolean);
                }
            }
            
            btn.innerHTML = '<i class="ph ph-magic-wand"></i> Get Suggestions';
            btn.disabled = false;
            
            renderSuggestions(suggestions, task, !!state.settings.apiKey);
        });
        
        // Modal close on click outside
        UI.personModal?.addEventListener('click', (e) => {
            if (e.target === e.currentTarget) closeModal();
        });
        
        $('#api-modal')?.addEventListener('click', (e) => {
            if (e.target === e.currentTarget) closeModal();
        });
        
        // API form
        $('#api-form')?.addEventListener('submit', (e) => {
            e.preventDefault();
            state.settings.apiKey = $('#api-key').value;
            state.settings.model = $('#api-model').value;
            save();
            closeModal();
            alert('Settings saved!');
        });
        
        // Keyboard
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') closeModal();
        });
        
        // Initialize date
        const dateInput = $('#task-due-date');
        if (dateInput) dateInput.setAttribute('min', today());
        
        // Initial render
        render();
        
        // Show tutorial for new users
        setTimeout(showTutorial, 500);
    };

    // ==================== EXPOSE FUNCTIONS ====================
    window.app = {
        deletePerson,
        editPerson: (id) => {
            const p = state.people.find(x => x.id === id);
            if (p) openModal(p);
        },
        deleteTask,
        completeTask,
        assignTask,
        reAssign,
        dismissNotify,
        dismissAllNotifies
    };

    window.addTrait = (t) => {
        const input = document.getElementById('p-traits');
        if (!input) return;
        const current = input.value.split(',').map(s => s.trim()).filter(Boolean);
        if (!current.includes(t)) {
            current.push(t);
            input.value = current.join(', ');
        }
    };

    // ==================== START ====================
    document.addEventListener('DOMContentLoaded', init);

})();