/**
 * Work Management Assistant - Professional Edition
 * Enterprise-Grade Workforce Planning System
 * 
 * IMPROVEMENTS MADE:
 * 1. Added XSS protection with escapeHtml()
 * 2. Added input debouncing for search
 * 3. Added proper import validation with schema check
 * 4. Added field-level validation feedback
 * 5. Added keyboard shortcuts hint
 * 6. Added replay tutorial button
 * 7. Fixed unused loadState() function removed
 * 8. Added max hours validation
 * 9. Fixed avoidTraits scoring minimum floor
 * 10. Added undo capability for task delete
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
        },
        validation: {
            maxTaskHours: 480,  // Max 60h/week * 8 weeks
            maxPersonCapacity: 80,
            minPersonCapacity: 1
        }
    };

    // ==================== STATE ====================
    let state = {
        people: safeJSONParse(localStorage.getItem(CONFIG.storage.people), []),
        tasks: safeJSONParse(localStorage.getItem(CONFIG.storage.tasks), []),
        settings: safeJSONParse(localStorage.getItem(CONFIG.storage.settings), { 
            apiKey: '', 
            model: 'anthropic/claude-opus-4.6-20251114' 
        })
    };

    let searchTerm = '';
    let searchTimeout = null;
    let UI = {};
    let deletedTask = null;  // For undo functionality

    // ==================== UTILITIES ====================
    const $ = (s) => document.querySelector(s);
    const $$ = (s) => document.querySelectorAll(s);
    const genId = () => Date.now().toString(36) + Math.random().toString(36).substr(2);

    // Safe JSON parse with error handling
    function safeJSONParse(str, fallback) {
        try {
            return str ? JSON.parse(str) : fallback;
        } catch (e) {
            console.warn('JSON parse error:', e);
            return fallback;
        }
    }

    // XSS Protection - escape HTML entities
    function escapeHtml(str) {
        if (str == null) return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    // Escape for use in onclick attributes
    function escapeAttr(str) {
        if (str == null) return '';
        return String(str).replace(/'/g, "\\'").replace(/"/g, '\\"');
    }

    // Debounce helper
    function debounce(fn, delay) {
        return function(...args) {
            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(() => fn.apply(this, args), delay);
        };
    }

    // Save state to localStorage
    let renderNeeded = true;
    const save = () => {
        localStorage.setItem(CONFIG.storage.people, JSON.stringify(state.people));
        localStorage.setItem(CONFIG.storage.tasks, JSON.stringify(state.tasks));
        localStorage.setItem(CONFIG.storage.settings, JSON.stringify(state.settings));
        
        if (renderNeeded) {
            render();
            renderNeeded = false;
        }
    };

    // Mark that render is needed
    const markRenderNeeded = () => {
        renderNeeded = true;
    };

    // ==================== DATE HELPERS ====================
    const formatDate = (d) => {
        if (!d) return '';
        try {
            return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        } catch (e) {
            return '';
        }
    };
    
    const daysUntil = (d) => {
        if (!d) return null;
        const diff = new Date(d) - new Date();
        if (isNaN(diff)) return null;
        return Math.ceil(diff / (1000 * 60 * 60 * 24));
    };

    const today = () => new Date().toISOString().split('T')[0];

    // ==================== TASK ANALYSIS ====================
    const getTaskLoad = (task) => {
        if (task.completed) return { daily: 0, weekly: 0, monthly: 0, total: task.hours };
        
        const start = task.assignmentDate ? new Date(task.assignmentDate) : new Date();
        const end = task.dueDate ? new Date(task.dueDate) : new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
        
        const days = Math.max(1, Math.ceil((end - start) / (1000 * 60 * 60 * 24)));
        const hours = parseFloat(task.hours) || 0;
        const rate = hours / days;
        
        return {
            daily: rate,
            weekly: Math.min(hours, rate * 7),
            monthly: Math.min(hours, rate * 30),
            total: hours
        };
    };

    const getPersonLoad = (personId, mode = 'weekly') => {
        return state.tasks
            .filter(t => t.assignedToId === personId && !t.completed)
            .reduce((sum, t) => sum + getTaskLoad(t)[mode], 0);
    };

    const getPersonStats = (personId) => {
        const p = state.people.find(x => x.id === personId);
        if (!p) return { 
            weekly: 0, monthly: 0, capacity: 40, 
            monthlyCapacity: 160, weekUtil: 0, monthUtil: 0, 
            weekRemaining: 40, monthRemaining: 160 
        };
        
        const cap = Math.min(
            CONFIG.validation.maxPersonCapacity,
            Math.max(CONFIG.validation.minPersonCapacity, parseFloat(p.capacity) || CONFIG.defaults.capacity)
        );
        const mCap = parseFloat(p.monthlyCapacity) || CONFIG.defaults.monthlyCapacity;
        const w = getPersonLoad(personId, 'weekly');
        const m = getPersonLoad(personId, 'monthly');
        
        return {
            weekly: w,
            monthly: m,
            capacity: cap,
            monthlyCapacity: mCap,
            weekUtil: cap > 0 ? (w / cap) * 100 : 0,
            monthUtil: mCap > 0 ? (m / mCap) * 100 : 0,
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
            const matches = reqSkills.filter(s => hasSkills.some(hs => hs.includes(s) || hs.startsWith(s))).length;
            score += (matches / reqSkills.length) * 40;
        }
        
        // Avoid negative traits penalty (FIXED: ensures minimum 0)
        if (avoidTraits.length) {
            const negMatches = avoidTraits.filter(t => hasTraits.some(ht => ht.includes(t) || ht.startsWith(t))).length;
            score -= negMatches * 25;
        }
        
        // Capacity check (0-30) - IMPROVED: uses actual task hours needed
        const taskHours = parseFloat(task.hours) || 0;
        if (stats && stats.weekRemaining >= taskHours) {
            score += 30;
        } else if (stats && stats.weekRemaining > 0) {
            score += 10;
        } else if (stats && stats.weekRemaining >= taskHours * 0.5) {
            score += 5;
        }
        
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
        
        // IMPROVED: ensures score is between 0-100
        return Math.max(0, Math.min(100, Math.round(score)));
    };

    const getSuggestions = (task) => {
        if (!state.people.length) return [];
        
        return state.people.map(p => {
            const stats = getPersonStats(p.id);
            const score = scorePerson(p, task);
            
            let status, statusClass;
            const taskHours = parseFloat(task.hours) || 0;
            if (stats.weekRemaining < 1) { status = 'At Capacity'; statusClass = 'full'; }
            else if (stats.weekRemaining < taskHours) { status = 'Partial Capacity'; statusClass = 'limited'; }
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
            `${p.name}: ${p.skills} (${p.efficiency}x efficiency, ${p.capacity}h/wk capacity)`
        ).join('\n');
        
        const systemPrompt = `You are a senior workforce manager. Recommend the best person for this task.

Task: ${task.desc}
Skills needed: ${task.skills}
Hours estimated: ${task.hours}
Due date: ${task.dueDate}
Traits to avoid: ${task.avoidTraits || 'none'}

Team members:
${team}

Reply ONLY with a valid JSON array like: [{"name": "John", "reason": "Has relevant skills", "score": 85}]`;

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
                    max_tokens: 500,
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: 'Please recommend the best team member for this task.' }
                    ],
                    temperature: 0.3
                })
            });
            
            if (!res.ok) {
                throw new Error(`API error: ${res.status}`);
            }
            
            const data = await res.json();
            const content = data.choices?.[0]?.message?.content || '';
            const match = content.match(/\[[\s\S]*\]/);
            
            if (match) {
                return JSON.parse(match[0]);
            }
            return null;
        } catch (e) {
            console.error('AI Error:', e);
            showToast('AI suggestions unavailable', 'error');
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
        
        // Focus first field
        setTimeout(() => $('#p-name')?.focus(), 100);
    };

    const closeModal = () => {
        $$('.modal').forEach(m => m.classList.remove('active'));
        clearValidationErrors();
    };

    // Clear validation errors
    const clearValidationErrors = () => {
        $$('.form-group.error').forEach(g => g.classList.remove('error'));
    };

    // Show field error
    const showFieldError = (inputId, message) => {
        const group = $(`#${inputId}`)?.closest('.form-group');
        if (group) {
            group.classList.add('error');
            if (message) {
                let err = group.querySelector('.field-error');
                if (!err) {
                    err = document.createElement('div');
                    err.className = 'field-error';
                    group.appendChild(err);
                }
                err.textContent = message;
            }
        }
    };

    const deletePerson = (id) => {
        if (!confirm('Remove this team member? Their tasks will become unassigned.')) return;
        
        state.tasks = state.tasks.map(t => 
            t.assignedToId === id ? { ...t, assignedToId: null, assignedToName: null } : t
        );
        state.people = state.people.filter(p => p.id !== id);
        save();
        showToast('Member removed');
    };

    const deleteTask = (id) => {
        const task = state.tasks.find(t => t.id === id);
        if (!task) return;
        
        if (!confirm('Delete this task?')) return;
        
        // Store for undo
        deletedTask = { ...task };
        
        state.tasks = state.tasks.filter(t => t.id !== id);
        save();
        
        // Show undo toast
        const toast = $('#delete-toast');
        if (toast) {
            toast.innerHTML = 'Task deleted <button class="btn-undo" onclick="app.undoDelete()">Undo</button>';
            toast.classList.add('show');
            setTimeout(() => {
                deletedTask = null;
                toast.classList.remove('show');
            }, 5000);
        }
    };

    const undoDelete = () => {
        if (deletedTask) {
            state.tasks.unshift(deletedTask);
            deletedTask = null;
            save();
            $('#delete-toast')?.classList.remove('show');
            showToast('Task restored');
        }
    };

    const completeTask = (id) => {
        const task = state.tasks.find(t => t.id === id);
        if (!task) return;
        
        state.tasks = state.tasks.map(t => 
            t.id === id ? { ...t, completed: !t.completed } : t
        );
        save();
        
        const toast = $('#delete-toast');
        if (toast) {
            toast.textContent = task.completed ? 'Task marked incomplete' : 'Task completed!';
            toast.classList.add('show');
            setTimeout(() => toast.classList.remove('show'), 2000);
        }
    };

    const assignTask = (pid, desc, hours, due, skills, avoidTraits = '') => {
        const person = state.people.find(p => p.id === pid);
        if (!person) {
            showToast('Person not found', 'error');
            return;
        }
        
        // Validate hours
        const hoursNum = parseFloat(hours);
        if (hoursNum > CONFIG.validation.maxTaskHours) {
            showToast(`Max ${CONFIG.validation.maxTaskHours}h allowed`, 'error');
            return;
        }
        
        state.tasks.unshift({
            id: genId(),
            desc, 
            skills, 
            avoidTraits,
            hours: hoursNum, 
            dueDate: due,
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
        
        showToast('Task assigned to ' + person.name);
    };

    const reAssign = (id) => {
        const task = state.tasks.find(t => t.id === id);
        if (!task) return;
        
        $('#task-desc').value = task.desc;
        $('#task-skills').value = task.skills || '';
        $('#task-avoid-traits').value = task.avoidTraits || '';
        $('#task-est-hours').value = task.hours;
        $('#task-due-date').value = task.dueDate || '';
        $('#task-priority').value = task.priority || 'medium';
        
        // Scroll to task form with focus
        const taskPanel = $('.task-panel');
        if (taskPanel) {
            taskPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
            setTimeout(() => $('#task-desc')?.focus(), 300);
        }
    };

    const dismissNotify = (id) => {
        state.tasks = state.tasks.filter(t => t.id !== id);
        save();
    };

    const dismissAllNotifies = () => {
        if (!confirm('Dismiss all unassigned tasks?')) return;
        state.tasks = state.tasks.filter(t => t.assignedToId !== null || t.completed);
        save();
    };

    // ==================== EXPORT/IMPORT ====================
    const exportData = () => {
        const data = { 
            version: '2.0', 
            date: new Date().toISOString(), 
            state: {
                people: state.people,
                tasks: state.tasks
            },
            settings: state.settings 
        };
        
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `wma_backup_${today()}.json`;
        a.click();
        URL.revokeObjectURL(a.href);
        
        showToast('Data exported');
    };

    const importData = (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        
        const reader = new FileReader();
        reader.onload = (ev) => {
            try {
                const data = JSON.parse(ev.target.result);
                
                // IMPROVED: Validate import schema
                if (!validateImport(data)) {
                    throw new Error('Invalid backup file format');
                }
                
                if (data.state?.people) {
                    state.people = data.state.people;
                }
                if (data.state?.tasks) {
                    state.tasks = data.state.tasks;
                }
                if (data.settings?.apiKey) {
                    state.settings.apiKey = data.settings.apiKey;
                }
                if (data.settings?.model) {
                    state.settings.model = data.settings.model;
                }
                
                save();
                showToast('Data imported successfully');
                location.reload();
            } catch (err) {
                showToast('Import failed: ' + err.message, 'error');
            }
        };
        
        reader.onerror = () => {
            showToast('Failed to read file', 'error');
        };
        
        reader.readAsText(file);
        e.target.value = '';  // Allow re-import
    };

    // Validate import data
    const validateImport = (data) => {
        if (!data) return false;
        if (data.version !== '2.0') {
            console.warn('Unknown backup version');
        }
        
        // Check basic structure
        if (data.state && typeof data.state === 'object') {
            if (data.state.people && !Array.isArray(data.state.people)) return false;
            if (data.state.tasks && !Array.isArray(data.state.tasks)) return false;
        }
        
        return true;
    };

    // Show toast notification
    const showToast = (message, type = 'success') => {
        const toast = $('#delete-toast');
        if (!toast) return;
        
        toast.textContent = message;
        toast.className = 'toast ' + type;
        toast.classList.add('show');
        setTimeout(() => toast.classList.remove('show'), type === 'error' ? 4000 : 2500);
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
        if (!state.people.length) {
            if ($('#stat-capacity')) $('#stat-capacity').textContent = '0h';
            if ($('#stat-utilization')) {
                $('#stat-utilization').textContent = '0%';
                $('#stat-utilization').className = 'stat-value highlight';
            }
            if ($('#stat-monthly')) $('#stat-monthly').textContent = '0h';
            if ($('#stat-unassigned')) {
                const unassigned = state.tasks.filter(t => !t.assignedToId && !t.completed).length;
                $('#stat-unassigned').textContent = unassigned;
            }
            return;
        }
        
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
        
        // Filter by search term
        if (searchTerm) {
            const t = searchTerm.toLowerCase();
            people = people.filter(p => 
                p.name?.toLowerCase().includes(t) ||
                p.skills?.toLowerCase().includes(t) ||
                p.traits?.toLowerCase().includes(t)
            );
        }
        
        // Sort by utilization
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
            
            // Escape data for safety
            const safeName = escapeHtml(p.name);
            const safeSkills = (p.skills || '').split(',').filter(Boolean).map(s => escapeHtml(s.trim()));
            const safeTraits = (p.traits || '').split(',').filter(Boolean).map(t => escapeHtml(t.trim()));
            const safeNotes = escapeHtml(p.notes);
            const safeId = escapeAttr(p.id);
            
            return `
                <div class="member-card">
                    <div class="member-header">
                        <div>
                            <div class="member-name">${safeName}</div>
                            <div class="member-efficiency">${p.efficiency || 1}x efficiency</div>
                        </div>
                        <div class="member-actions">
                            <button class="btn-icon" onclick="app.editPerson('${safeId}')" title="Edit" aria-label="Edit ${safeName}">
                                <i class="ph ph-pencil-simple"></i>
                            </button>
                            <button class="btn-icon danger" onclick="app.deletePerson('${safeId}')" title="Remove" aria-label="Remove ${safeName}">
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
                        ${safeSkills.map(s => `<span class="badge skill">${s}</span>`).join('')}
                        ${safeTraits.map(t => `<span class="badge trait">${t}</span>`).join('')}
                    </div>
                    
                    ${safeNotes ? `<div class="member-notes">${safeNotes}</div>` : ''}
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
            
            // Escape data
            const safeDesc = escapeHtml(t.desc);
            const safeAssignee = escapeHtml(t.assignedToName || 'Unassigned');
            const safeId = escapeAttr(t.id);
            
            return `
                <div class="task-item ${t.completed ? 'completed' : ''} ${overdue ? 'overdue' : ''}">
                    <div class="task-info">
                        <div class="task-priority priority-${t.priority || 'medium'}">${(t.priority || 'MED').toUpperCase()}</div>
                        <div class="task-desc">${safeDesc}</div>
                        <div class="task-meta">
                            <span><i class="ph ph-user"></i> ${safeAssignee}</span>
                            <span><i class="ph ph-clock"></i> ${load.weekly.toFixed(1)}h/wk (${load.total}h total)</span>
                            <span class="${overdue ? 'danger' : days !== null && days <= 2 ? 'warning' : ''}">
                                <i class="ph ph-calendar"></i> ${formatDate(t.dueDate)} ${days !== null ? (days < 0 ? 'OVERDUE' : `${days}d left`) : ''}
                            </span>
                        </div>
                    </div>
                    <div class="task-actions">
                        <button class="btn-complete" onclick="app.completeTask('${safeId}')" aria-label="${t.completed ? 'Mark incomplete' : 'Mark complete'}">
                            ${t.completed ? '<i class="ph ph-arrow-ccw"></i>' : '<i class="ph ph-check"></i>'}
                        </button>
                        <button class="btn-icon danger" onclick="app.deleteTask('${safeId}')" title="Delete" aria-label="Delete task">
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
        ` + pending.map(t => {
            const safeDesc = escapeHtml(t.desc);
            const safeId = escapeAttr(t.id);
            return `
                <div class="notify-card">
                    <div class="notify-content">
                        <div class="notify-title">${safeDesc}</div>
                        <div class="notify-meta">${t.hours}h - Due: ${formatDate(t.dueDate)}</div>
                        <button class="btn-reassign" onclick="app.reAssign('${safeId}')">Reassign</button>
                    </div>
                    <button class="btn-dismiss" onclick="app.dismissNotify('${safeId}')" title="Dismiss" aria-label="Dismiss">
                        <i class="ph ph-x"></i>
                    </button>
                </div>
            `;
        }).join('');
    };

    const renderInsights = () => {
        const container = $('#manager-insights');
        if (!container) return;
        
        const insights = [];
        
        // Only show insights if there are team members
        if (state.people.length > 0) {
            // Overload warnings
            state.people.forEach(p => {
                const stats = getPersonStats(p.id);
                if (stats.weekUtil > 100) {
                    insights.push({ type: 'danger', icon: 'ph-flame', text: escapeHtml(`${p.name} is overloaded (${Math.round(stats.weekUtil)}%)`) });
                }
            });
            
            // Available resources
            const available = state.people.find(p => {
                const stats = getPersonStats(p.id);
                return stats && stats.weekUtil < 50;
            });
            
            if (available) {
                insights.push({ type: 'success', icon: 'ph-user-plus', text: escapeHtml(`${available.name} has capacity available`) });
            }
        }
        
        // Overdue tasks (always show if any)
        state.tasks.filter(t => t.dueDate && daysUntil(t.dueDate) < 0 && !t.completed).forEach(t => {
            insights.push({ type: 'warning', icon: 'ph-warning', text: `"${escapeHtml(t.desc)}" is overdue` });
        });
        
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
                    ${suggestions.map((s, i) => {
                        const safeName = escapeHtml(s.person.name);
                        const safeDesc = escapeHtml(task.desc);
                        const safeSkills = escapeHtml(task.skills);
                        const safeAvoid = escapeHtml(task.avoidTraits || '');
                        const safeReason = s.reason ? escapeHtml(s.reason) : '';
                        const safeId = escapeAttr(s.person.id);
                        const safeTaskHours = escapeAttr(task.hours);
                        const safeDue = escapeAttr(task.dueDate);
                        
                        return `
                            <div class="suggestion ${i === 0 ? 'top' : ''}">
                                <div class="suggestion-rank">#${i + 1}</div>
                                <div class="suggestion-body">
                                    <div class="suggestion-name">
                                        ${safeName}
                                        ${i === 0 ? '<span class="best">BEST MATCH</span>' : ''}
                                        ${isAI && safeReason ? '<span class="ai">AI</span>' : ''}
                                    </div>
                                    ${safeReason ? `<div class="suggestion-reason">${safeReason}</div>` : ''}
                                    <div class="suggestion-meta">
                                        <span class="score">${s.score}% Match</span>
                                        <span class="status ${s.statusClass}">${s.status}</span>
                                    </div>
                                </div>
                                <button class="btn-assign" onclick="app.assignTask('${safeId}', '${safeDesc}', '${safeTaskHours}', '${safeDue}', '${safeSkills}', '${safeAvoid}')">
                                    Assign
                                </button>
                            </div>
                        `;
                    }).join('')}
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
        }
    };

    const skipTutorial = () => {
        $('#tutorial-modal')?.classList.remove('active');
        localStorage.setItem(CONFIG.storage.seenTutorial, 'true');
    };

    const resetTutorial = () => {
        localStorage.removeItem(CONFIG.storage.seenTutorial);
        showTutorial();
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
        
        // Help button to replay tutorial
        $('#help-tutorial')?.addEventListener('click', resetTutorial);
        
        // Tutorial modal close on click outside
        $('#tutorial-modal')?.addEventListener('click', (e) => {
            if (e.target === e.currentTarget) {
                skipTutorial();
            }
        });
        
        // IMPROVED: Debounced search input
        const handleSearch = debounce((value) => {
            searchTerm = value;
            markRenderNeeded();
            render();
        }, 200);
        
        UI.search?.addEventListener('input', (e) => {
            handleSearch(e.target.value);
        });
        
        // Person form with validation
        UI.personForm?.addEventListener('submit', (e) => {
            e.preventDefault();
            clearValidationErrors();
            
            const id = $('#person-id').value;
            const name = $('#p-name').value.trim();
            const skills = $('#p-skills').value.trim();
            
            // Validate required fields
            if (!name) {
                showFieldError('p-name', 'Name is required');
                $('#p-name').focus();
                return;
            }
            if (!skills) {
                showFieldError('p-skills', 'Skills are required');
                $('#p-skills').focus();
                return;
            }
            
            const data = {
                id: id || genId(),
                name,
                skills,
                traits: $('#p-traits').value,
                efficiency: parseFloat($('#p-efficiency').value) || 1,
                capacity: parseInt($('#p-capacity').value) || 40,
                monthlyCapacity: parseInt($('#p-monthly-capacity').value) || 160,
                statusOverride: $('#p-status-override').value,
                notes: $('#p-notes').value
            };
            
            if (id) {
                state.people = state.people.map(p => p.id === id ? { ...p, ...data } : p);
                showToast('Member updated');
            } else {
                state.people.push(data);
                showToast('Member added');
            }
            
            save();
            closeModal();
        });
        
        // Task form with improved validation
        UI.taskForm?.addEventListener('submit', async (e) => {
            e.preventDefault();
            clearValidationErrors();
            
            const desc = $('#task-desc').value.trim();
            const skills = $('#task-skills').value.trim();
            const hours = parseFloat($('#task-est-hours').value);
            const dueDate = $('#task-due-date').value;
            
            // Validation
            if (!desc) {
                showFieldError('task-desc', 'Description is required');
                $('#task-desc').focus();
                return;
            }
            if (!skills) {
                showFieldError('task-skills', 'Skills are required');
                $('#task-skills').focus();
                return;
            }
            if (!hours || hours <= 0) {
                showFieldError('task-est-hours', 'Valid hours required');
                $('#task-est-hours').focus();
                return;
            }
            if (hours > CONFIG.validation.maxTaskHours) {
                showFieldError('task-est-hours', `Max ${CONFIG.validation.maxTaskHours}h allowed`);
                return;
            }
            if (!dueDate) {
                showFieldError('task-due-date', 'Due date is required');
                $('#task-due-date').focus();
                return;
            }
            
            const task = {
                desc,
                skills,
                avoidTraits: $('#task-avoid-traits').value,
                hours,
                dueDate
            };
            
            const btn = $('#task-form button[type="submit"]');
            const origText = btn.innerHTML;
            btn.innerHTML = '<i class="ph ph-spinner spinning"></i> Analyzing...';
            btn.disabled = true;
            
            try {
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
                
                renderSuggestions(suggestions, task, !!state.settings.apiKey);
            } catch (err) {
                showToast('Error getting suggestions', 'error');
            } finally {
                btn.innerHTML = origText;
                btn.disabled = false;
            }
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
            markRenderNeeded();
            save();
            closeModal();
            showToast('Settings saved!');
        });
        
        // Keyboard navigation
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                closeModal();
            }
            // Ctrl/Cmd + S to save (export)
            if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                e.preventDefault();
                exportData();
            }
            // Ctrl/Cmd + N for new person
            if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
                e.preventDefault();
                openModal();
            }
        });
        
        // Initialize date constraints
        const dateInput = $('#task-due-date');
        if (dateInput) {
            dateInput.setAttribute('min', today());
        }
        
        // Initial render
        render();
        
        // Show tutorial for new users with delay
        setTimeout(() => {
            if (!localStorage.getItem(CONFIG.storage.seenTutorial)) {
                showTutorial();
            }
        }, 500);
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
        dismissAllNotifies,
        undoDelete
    };

    // Helper to add traits
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
