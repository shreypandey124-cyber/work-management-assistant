/**
 * Work Management Assistant - Core Logic
 */

// --- State Management ---
let state = {
    people: JSON.parse(localStorage.getItem('wma_people')) || [],
    tasks: JSON.parse(localStorage.getItem('wma_tasks')) || []
};

let searchTerm = ''; // For global search

const ANTHROPIC_API_URL = 'https://openrouter.ai/api/v1/chat/completions';

let apiConfig = {
    apiKey: localStorage.getItem('wma_api_key') || '',
    model: localStorage.getItem('wma_api_model') || 'anthropic/claude-opus-4.6-20251114'
};

const saveApiConfig = () => {
    localStorage.setItem('wma_api_key', apiConfig.apiKey);
    localStorage.setItem('wma_api_model', apiConfig.model);
};

const saveState = () => {
    localStorage.setItem('wma_people', JSON.stringify(state.people));
    localStorage.setItem('wma_tasks', JSON.stringify(state.tasks));
    render();
};

// --- DOM Elements ---
const peopleGrid = document.getElementById('people-grid');
const peopleCount = document.getElementById('people-count');
const personModal = document.getElementById('person-modal');
const personForm = document.getElementById('person-form');
const taskForm = document.getElementById('task-form');
const suggestionContainer = document.getElementById('suggestion-container');
const taskHistory = document.getElementById('task-history');
const apiModal = document.getElementById('api-modal');
const apiForm = document.getElementById('api-form');

// --- Helpers ---
const generateId = () => Math.random().toString(36).substr(2, 9);

const parseCSV = (str) => str ? str.split(',').map(s => s.trim()).filter(s => s !== '') : [];

const getTaskBurnRate = (task) => {
    if (task.completed) return 0;
    
    const start = task.assignmentDate ? new Date(task.assignmentDate) : new Date(task.timestamp);
    const end = task.dueDate ? new Date(task.dueDate) : new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
    
    const diffTime = Math.max(0, end - start);
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    const weeks = Math.max(1, diffDays / 7);
    
    return {
        weeklyHours: (parseFloat(task.hours) || 0) / weeks,
        totalHours: parseFloat(task.hours) || 0
    };
};

const getAllocatedHours = (personId, mode = 'weekly') => {
    return state.tasks
        .filter(t => t.assignedToId === personId && !t.completed)
        .reduce((sum, t) => {
            const rates = getTaskBurnRate(t);
            return sum + (mode === 'weekly' ? rates.weeklyHours : rates.totalHours);
        }, 0);
};

// --- Suggestion Engine ---
// --- Suggestion Engine ---
// --- Suggestion Engine ---
const getSuggestions = (task) => {
    const requiredSkills = parseCSV(task.skills).map(s => s.toLowerCase());
    const requiredHours = parseFloat(task.hours) || 0;
    const dueDate = task.dueDate ? new Date(task.dueDate) : null;
    const today = new Date();

    if (state.people.length === 0) return [];

    const suggestions = state.people.map(person => {
        let score = 0;
        const personSkills = parseCSV(person.skills).map(s => s.toLowerCase());

        // 1. Skill Match (Primary - up to 50 pts)
        const matchCount = requiredSkills.filter(s => personSkills.includes(s)).length;
        const skillMatchRate = requiredSkills.length > 0 ? (matchCount / requiredSkills.length) : 0;
        score += skillMatchRate * 50;

        // 2. Efficiency & Urgency (Max 30 pts)
        const efficiency = parseFloat(person.efficiency) || 1.0;

        // If due date is close (within 3 days), efficiency is critical
        if (dueDate) {
            const diffTime = Math.max(0, dueDate - today);
            const diffDays = diffTime / (1000 * 60 * 60 * 24);
            if (diffDays < 3) {
                score += efficiency * 15; // Speed bonus for urgent tasks
            } else {
                score += efficiency * 5;
            }
        } else {
            score += efficiency * 10;
        }

        // 3. Capacity Availability (Critical - up to 40 pts)
        const allocated = getAllocatedHours(person.id);
        const capacity = parseFloat(person.capacity) || 40;
        const remaining = capacity - allocated;

        let status = 'Available';
        let statusClass = 'text-success';
        
        // --- Manager Override Logic ---
        const override = person.statusOverride || 'auto';
        if (override !== 'auto') {
            if (override === 'available') {
                score += 40;
                status = 'Forced Available';
                statusClass = 'text-success';
            } else if (override === 'busy') {
                score -= 40;
                status = 'Forced Busy';
                statusClass = 'text-warning';
            } else if (override === 'away') {
                score = -100; // Manager says they are away
                status = 'Away / OOO';
                statusClass = 'text-danger';
            }
        } else {
            // Standard Auto Logic
            if (remaining < requiredHours) {
                score -= 60;
                status = 'Full (Unavailable)';
                statusClass = 'text-danger';
            } else if (remaining < (capacity * 0.25)) {
                score += 5;
                status = 'Busy (Limited)';
                statusClass = 'text-warning';
            } else {
                score += 40;
            }
        }

        const finalPercent = Math.max(0, Math.min(100, Math.round(score)));
        return { person, score: finalPercent, status, statusClass, allocated, capacity, remaining, override };
    });

    return suggestions
        .filter(s => s.score > 5)
        .sort((a, b) => b.score - a.score);
};

const getClaudeSuggestions = async (task) => {
    if (!apiConfig.apiKey) return null;

    const systemPrompt = `You are a task assignment assistant. Given the following task and team members, recommend the best person for the job.

Team Members:
${state.people.map(p => `- ${p.name}: Skills: ${p.skills || 'none'}, Traits: ${p.traits || 'none'}, Efficiency: ${p.efficiency || 1}x, Weekly Capacity: ${p.capacity || 40}hrs`).join('\n')}

Current Task Assignments (hours allocated):
${state.people.map(p => `- ${p.name}: ${getAllocatedHours(p.id)}hrs allocated`).join('\n')}

Task: ${task.desc}
Required Skills: ${task.skills}
Estimated Hours: ${task.hours}
${task.dueDate ? `Due Date: ${task.dueDate}` : ''}

Respond with ONLY a JSON array of the top 3 candidates in this exact format:
[{"name": "Person Name", "reason": "1-2 sentence explanation", "score": 85}]

Important: Consider the duration of the task. If the deadline is weeks away, prioritize people with long-term monthly capacity, even if they are busy today.

Only include people who have the required skills. Score out of 100.`;

    try {
        const response = await fetch(ANTHROPIC_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiConfig.apiKey}`,
                'HTTP-Referer': window.location.origin,
                'X-Title': 'Work Management Assistant'
            },
            body: JSON.stringify({
                model: apiConfig.model,
                max_tokens: 500,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: 'Provide recommendations.' }
                ]
            })
        });

        if (!response.ok) throw new Error('API request failed');

        const data = await response.json();
        const content = data.choices[0].message.content;
        const jsonMatch = content.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
            return JSON.parse(jsonMatch[0]);
        }
        return null;
    } catch (err) {
        console.error('OpenRouter API error:', err);
        return null;
    }
};

// --- UI Actions ---
const openModal = (person = null) => {
    if (person) {
        document.getElementById('modal-title').textContent = 'Edit Person';
        document.getElementById('person-id').value = person.id;
        document.getElementById('p-name').value = person.name;
        document.getElementById('p-skills').value = person.skills;
        document.getElementById('p-traits').value = person.traits;
        document.getElementById('p-efficiency').value = person.efficiency;
        document.getElementById('p-capacity').value = person.capacity || 40;
        document.getElementById('p-status-override').value = person.statusOverride || 'auto';
        document.getElementById('p-notes').value = person.notes || '';
    } else {
        document.getElementById('modal-title').textContent = 'Add Person';
        personForm.reset();
        document.getElementById('person-id').value = '';
        document.getElementById('p-name').value = '';
        document.getElementById('p-skills').value = '';
        document.getElementById('p-traits').value = '';
        document.getElementById('p-efficiency').value = '1.0';
        document.getElementById('p-capacity').value = '40';
    }
    personModal.style.display = 'flex';
};

const closeModal = () => {
    personModal.style.display = 'none';
};

const deletePerson = (id) => {
    // Removed confirm() for instant action as requested
    // Unassign their tasks using ID
    state.tasks = state.tasks.map(t =>
        (t.assignedToId === id && !t.completed) ? { ...t, assignedToId: null } : t
    );
    state.people = state.people.filter(p => p.id !== id);
    saveState();
};

const completeTask = (taskId) => {
    state.tasks = state.tasks.map(t => t.id === taskId ? { ...t, completed: !t.completed } : t);
    saveState();
};

const deleteTask = (taskId) => {
    // Removed confirm() for instant action as requested
    state.tasks = state.tasks.filter(t => t.id !== taskId);
    saveState();
};

const updateTaskHours = (taskId, newHours) => {
    state.tasks = state.tasks.map(t => t.id === taskId ? { ...t, hours: parseFloat(newHours) || 0 } : t);
    saveState();
};

const assignTask = (personId, taskDesc, taskHours, taskDueDate, taskSkills = '') => {
    const person = state.people.find(p => p.id === personId);
    if (!person) return;

    const newTask = {
        id: generateId(),
        desc: taskDesc,
        skills: taskSkills,
        hours: parseFloat(taskHours) || 0,
        dueDate: taskDueDate || null,
        priority: document.getElementById('task-priority').value || 'medium',
        assignmentDate: new Date().toISOString(), // Adding start date for smoothing logic
        assignedToId: person.id,
        assignedToName: person.name,
        timestamp: new Date().toLocaleString(),
        completed: false
    };
    state.tasks.unshift(newTask);
    suggestionContainer.style.display = 'none';
    taskForm.reset();
    saveState();
};

// --- Rendering ---
const render = () => {
    // Render People
    peopleCount.textContent = `${state.people.length} Member${state.people.length !== 1 ? 's' : ''}`;

    if (state.people.length === 0) {
        peopleGrid.innerHTML = `
            <div class="empty-state">
                <i class="ph ph-users-three" style="font-size: 3rem; margin-bottom: 1rem; display: block;"></i>
                <p>No team members added yet.<br>Start by adding people with their traits and skills.</p>
            </div>
        `;
    } else {
        const filteredPeople = state.people.filter(p => {
            const term = searchTerm.toLowerCase();
            return p.name.toLowerCase().includes(term) || 
                   (p.skills && p.skills.toLowerCase().includes(term)) || 
                   (p.traits && p.traits.toLowerCase().includes(term));
        });

        // Sort by Availability (Lowest Utilization first)
        const sortedPeople = [...filteredPeople].sort((a, b) => {
            const utilA = getAllocatedHours(a.id, 'weekly') / (parseFloat(a.capacity) || 40);
            const utilB = getAllocatedHours(b.id, 'weekly') / (parseFloat(b.capacity) || 40);
            return utilA - utilB;
        });

        if (sortedPeople.length === 0) {
            peopleGrid.innerHTML = `
                <div class="empty-state">
                    <p>No team members matching "${searchTerm}"</p>
                </div>
            `;
        } else {
            peopleGrid.innerHTML = sortedPeople.map(p => {
                const weeklyAllocated = getAllocatedHours(p.id, 'weekly');
                const monthlyAllocated = getAllocatedHours(p.id, 'monthly');
                const capacity = parseFloat(p.capacity) || 40;
                const monthlyCapacity = capacity * 4;
                
                const remainingWeekly = capacity - weeklyAllocated;
                const workloadClass = remainingWeekly < 5 ? 'workload-high' : 'badge-workload';
                const hasOverride = p.statusOverride && p.statusOverride !== 'auto';
    
                return `
                <div class="glass-card person-card fade-in">
                    <!-- ... Header ... -->
                    <div class="person-header">
                        <span class="person-name">${p.name}</span>
                        <div class="actions">
                            <button type="button" class="btn-danger btn-icon" onclick="event.stopPropagation(); window.deletePerson('${p.id}')"><i class="ph ph-trash"></i></button>
                            <button type="button" class="btn-secondary btn-icon" onclick="event.stopPropagation(); window.editPerson('${p.id}')"><i class="ph ph-pencil"></i></button>
                        </div>
                    </div>
                    
                    <div class="person-stats">
                        <div class="stat-item"><i class="ph ph-lightning"></i> ${p.efficiency}x</div>
                        <div class="stat-item" title="Weekly Balance"><i class="ph ph-calendar-check"></i> ${Math.round(weeklyAllocated)} / ${capacity}h</div>
                    </div>
                    
                    <!-- Weekly Progress -->
                    <div style="font-size: 0.65rem; color: var(--text-dim); margin-top: 0.5rem;">WEEKLY LOAD</div>
                    <div class="progress-bar-container" style="background: rgba(255,255,255,0.05); height: 6px; border-radius: 3px; margin: 0.25rem 0 0.75rem 0; overflow: hidden;">
                        <div style="width: ${Math.min(100, (weeklyAllocated / capacity) * 100)}%; height: 100%; background: ${remainingWeekly < 5 ? 'var(--danger)' : 'var(--accent)'}; transition: width 0.3s;"></div>
                    </div>

                    <!-- Monthly Progress -->
                    <div style="font-size: 0.65rem; color: var(--text-dim);">MONTHLY PIPELINE (${Math.round(monthlyAllocated)} / ${monthlyCapacity}h)</div>
                    <div class="progress-bar-container" style="background: rgba(255,255,255,0.05); height: 4px; border-radius: 2px; margin: 0.25rem 0 1rem 0; overflow: hidden;">
                        <div style="width: ${Math.min(100, (monthlyAllocated / monthlyCapacity) * 100)}%; height: 100%; background: var(--text-dim); opacity: 0.5; transition: width 0.3s;"></div>
                    </div>

                    <div class="badge-group">
                        <span class="badge ${workloadClass}">${remainingWeekly < 1 ? 'Full' : (remainingWeekly < 10 ? 'Busy' : 'Available')}</span>
                        ${hasOverride ? `<span class="badge badge-override"><i class="ph ph-shield-check"></i> ${p.statusOverride.toUpperCase()}</span>` : ''}
                        ${parseCSV(p.skills).map(s => `<span class="badge badge-skill">${s}</span>`).join('')}
                        ${parseCSV(p.traits).map(t => `<span class="badge badge-trait">${t}</span>`).join('')}
                    </div>
                    ${p.notes ? `<div class="manager-note">${p.notes}</div>` : ''}
                </div>
            `}).join('');
        }
    }

    // Render Recent Tasks
    if (state.tasks.length === 0) {
        taskHistory.innerHTML = '<p class="empty-state" style="padding: 1rem; border: none;">No tasks assigned yet.</p>';
    } else {
        taskHistory.innerHTML = state.tasks
            .filter(t => t.assignedToId !== null) // Corrected property check
            .map(t => {
                const priorityClass = `priority-${t.priority || 'medium'}`;
                const priorityTag = `priority-tag-${t.priority || 'medium'}`;
                const isOverdue = t.dueDate && new Date(t.dueDate) < new Date() && !t.completed;
                
                return `
                <div class="task-item glass-card ${t.completed ? 'completed' : ''} ${priorityClass} ${isOverdue ? 'overdue' : ''}" style="margin-bottom: 0.5rem; padding: 0.75rem; border-color: rgba(255,255,255,0.1);">
                    <div style="display: flex; justify-content: space-between; align-items: flex-start;">
                        <div style="flex: 1;">
                            <div style="font-size: 0.85rem; color: var(--text-secondary); margin-bottom: 0.25rem;">
                                <span class="priority-tag ${priorityTag}">${t.priority || 'MED'}</span>
                                ${t.timestamp} ${t.dueDate ? `• Due: ${t.dueDate}` : ''}
                            </div>
                            <div style="font-weight: 500;">${t.desc}</div>
                            <div style="color: var(--accent); font-size: 0.8rem; margin-top: 0.25rem;">
                                Assigned to: ${t.assignedToName || 'Unknown'} • 
                                ${getTaskBurnRate(t).weeklyHours.toFixed(1)}h/wk (${t.hours}h total)
                            </div>
                        </div>
                        <div style="display: flex; gap: 0.5rem; align-items: center;">
                            <button type="button" class="btn-complete" style="background: ${t.completed ? 'var(--bg-input)' : 'var(--success)'};" onclick="event.stopPropagation(); window.completeTask('${t.id}')">
                                ${t.completed ? '<i class="ph ph-arrow-counter-clockwise"></i>' : '<i class="ph ph-check"></i> Done'}
                            </button>
                            <button type="button" class="btn-danger btn-icon" style="padding: 0.25rem;" onclick="event.stopPropagation(); window.deleteTask('${t.id}')">
                                <i class="ph ph-trash"></i>
                            </button>
                        </div>
                    </div>
                </div>
            `}).join('');
    }

    // Render Notifications (Reassignments)
    const pendingTasks = state.tasks.filter(t => t.assignedToId === null && !t.completed);
    const notifSection = document.getElementById('notification-section');
    const notifList = document.getElementById('reassignment-list');
    const notifCount = document.getElementById('notif-count');

    if (pendingTasks.length > 0) {
        notifSection.style.display = 'block';
        notifCount.textContent = pendingTasks.length;
        notifList.innerHTML = pendingTasks.map(t => `
            <div class="reassignment-card fade-in">
                <div style="font-weight: 600; font-size: 0.9rem;">Task: ${t.desc}</div>
                <div style="font-size: 0.75rem; color: var(--text-secondary); margin: 0.2rem 0;">Needs owner (${t.hours} hrs)</div>
                <button type="button" class="btn btn-primary" style="width: 100%; padding: 0.3rem; font-size: 0.75rem; margin-top: 0.5rem;" onclick="event.stopPropagation(); window.reAssignTask('${taskId}')">
                    Find New Owner
                </button>
            </div>
        `).join('');
    } else {
        notifSection.style.display = 'none';
    }

    // --- NEW: Management Dashboard Stats ---
    renderDashboardStats();
    renderInsights();
};

const renderDashboardStats = () => {
    const totalWeeklyCapacity = state.people.reduce((sum, p) => sum + (parseFloat(p.capacity) || 40), 0);
    const totalWeeklyAllocated = state.people.reduce((sum, p) => sum + getAllocatedHours(p.id, 'weekly'), 0);
    const totalMonthlyAllocated = state.people.reduce((sum, p) => sum + getAllocatedHours(p.id, 'monthly'), 0);
    const unassignedCount = state.tasks.filter(t => !t.assignedToId && !t.completed).length;
    
    const utilization = totalWeeklyCapacity > 0 ? Math.round((totalWeeklyAllocated / totalWeeklyCapacity) * 100) : 0;
    
    document.getElementById('stat-total-capacity').textContent = `${Math.round(totalWeeklyCapacity)}h/wk`;
    document.getElementById('stat-utilization').textContent = `${utilization}%`;
    document.getElementById('stat-monthly-total').textContent = `${Math.round(totalMonthlyAllocated)}h`;
    document.getElementById('stat-unassigned').textContent = unassignedCount;
    
    const utilElement = document.getElementById('stat-utilization');
    utilElement.className = 'metric-value highlight ' + (utilization > 90 ? 'danger' : (utilization > 70 ? 'warning' : ''));
};

const renderInsights = () => {
    const insightsContainer = document.getElementById('manager-insights');
    const insights = [];
    
    // 1. Burnout Detection
    state.people.forEach(p => {
        const weekly = getAllocatedHours(p.id, 'weekly');
        const cap = parseFloat(p.capacity) || 40;
        if (weekly > cap * 1.1) {
            insights.push({
                type: 'danger',
                msg: `<strong>Burnout Alert:</strong> ${p.name} is scheduled for ${Math.round(weekly)}h this week (${Math.round((weekly/cap)*100)}% load).`,
                icon: 'ph-flame'
            });
        }
    });
    
    // 2. Overdue Check
    const today = new Date();
    const overdue = state.tasks.filter(t => t.dueDate && new Date(t.dueDate) < today && !t.completed);
    if (overdue.length > 0) {
        insights.push({
            type: 'warning',
            msg: `<strong>Deadline Missed:</strong> ${overdue.length} assigned task(s) are past their due date.`,
            icon: 'ph-clock-countdown'
        });
    }
    
    // 3. Resource Highlight
    if (state.people.length > 0) {
        const topResource = [...state.people].sort((a, b) => {
            const utilizationA = getAllocatedHours(a.id, 'weekly') / (parseFloat(a.capacity) || 40);
            const utilizationB = getAllocatedHours(b.id, 'weekly') / (parseFloat(b.capacity) || 40);
            return utilizationA - utilizationB;
        })[0];
        
        const capacity = parseFloat(topResource.capacity) || 40;
        const load = Math.round((getAllocatedHours(topResource.id, 'weekly') / capacity) * 100);
        if (load < 50) {
            insights.push({
                type: 'success',
                msg: `<strong>Top Resource:</strong> ${topResource.name} has significant availability (${load}% load).`,
                icon: 'ph-chart-line-up'
            });
        }
    }

    if (insights.length > 0) {
        insightsContainer.style.display = 'block';
        insightsContainer.innerHTML = insights.map(ins => `
            <div class="insight-tile ${ins.type} fade-in">
                <i class="ph ${ins.icon}"></i>
                <span>${ins.msg}</span>
            </div>
        `).join('');
    } else {
        insightsContainer.style.display = 'none';
    }
};

// --- Backup & Restore ---
const exportData = () => {
    const backupData = {
        state: state,
        apiConfig: apiConfig,
        version: '1.1'
    };
    
    const dataStr = JSON.stringify(backupData, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const exportFileDefaultName = `wma_backup_${new Date().toISOString().slice(0, 10)}.json`;

    const linkElement = document.createElement('a');
    linkElement.setAttribute('href', url);
    linkElement.setAttribute('download', exportFileDefaultName);
    linkElement.click();
    
    // Cleanup
    setTimeout(() => URL.revokeObjectURL(url), 100);
};

const importData = (event) => {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const result = e.target.result;
            if (!result) throw new Error('File is empty');
            
            const backup = JSON.parse(result);
            
            // Handle both old (state-only) and new (backupData) formats
            let importedState, importedConfig;
            
            if (backup.state && backup.apiConfig) {
                importedState = backup.state;
                importedConfig = backup.apiConfig;
            } else if (backup.people && backup.tasks) {
                importedState = backup; // Old format
            } else {
                throw new Error('Data structure is invalid. Please use a valid WMA backup file.');
            }
            
            if (importedState) {
                state = importedState;
                saveState();
            }
            if (importedConfig) {
                apiConfig = importedConfig;
                saveApiConfig();
            }
            
            alert('Success: All data and settings have been restored!');
            window.location.reload(); // Refresh to apply all UI changes correctly
        } catch (err) {
            console.error('Import Error:', err);
            alert('Error: ' + err.message);
        }
    };
    reader.readAsText(file);
};

// --- Event Listeners ---
document.getElementById('open-add-person').addEventListener('click', () => openModal());
document.getElementById('close-modal').addEventListener('click', closeModal);
document.getElementById('backup-data').addEventListener('click', exportData);
document.getElementById('restore-trigger').addEventListener('click', () => document.getElementById('restore-data').click());
document.getElementById('restore-data').addEventListener('change', importData);

document.getElementById('global-search').addEventListener('input', (e) => {
    searchTerm = e.target.value;
    render();
});

personForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const id = document.getElementById('person-id').value;
    const personData = {
        id: id || generateId(),
        name: document.getElementById('p-name').value,
        skills: document.getElementById('p-skills').value,
        traits: document.getElementById('p-traits').value,
        efficiency: document.getElementById('p-efficiency').value,
        capacity: document.getElementById('p-capacity').value,
        statusOverride: document.getElementById('p-status-override').value, // Manager Control
        notes: document.getElementById('p-notes').value // Manager Notes
    };

    if (id) {
        state.people = state.people.map(p => p.id === id ? personData : p);
    } else {
        state.people.push(personData);
    }

    saveState();
    closeModal();
});

taskForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const task = {
        desc: document.getElementById('task-desc').value,
        skills: document.getElementById('task-skills').value,
        hours: document.getElementById('task-est-hours').value,
        dueDate: document.getElementById('task-due-date').value
    };

    if (!task.desc || !task.skills || !task.hours || !task.dueDate) {
        alert("Please fill in all task details, including the due date.");
        return;
    }

    const localSuggestions = getSuggestions(task);

    const submitBtn = taskForm.querySelector('button[type="submit"]');
    const originalBtnText = submitBtn.innerHTML;
    submitBtn.innerHTML = '<i class="ph ph-spinner spinning"></i> Analyzing...';
    submitBtn.disabled = true;

    let suggestions = localSuggestions;

    if (apiConfig.apiKey) {
        const claudeResults = await getClaudeSuggestions(task);
        if (claudeResults && claudeResults.length > 0) {
            suggestions = claudeResults.map(r => {
                const person = state.people.find(p => p.name === r.name);
                const allocated = person ? getAllocatedHours(person.id) : 0; // Fixed: use person.id
                const capacity = person ? (parseFloat(person.capacity) || 40) : 40;
                const remaining = capacity - allocated;

                let status = remaining >= task.hours ? 'Available' : 'Full (Unavailable)';
                let statusClass = remaining >= task.hours ? 'text-success' : 'text-danger';

                return {
                    person,
                    score: r.score,
                    reason: r.reason,
                    status,
                    statusClass,
                    allocated,
                    capacity,
                    remaining
                };
            }).filter(s => s.person);
        }
    }

    submitBtn.innerHTML = originalBtnText;
    submitBtn.disabled = false;

    if (suggestions.length > 0) {
        suggestionContainer.innerHTML = `
            <div class="suggestion-result">
                <div class="suggestion-title">Ranked Recommendations</div>
                <div class="suggestion-list">
                    ${suggestions.map((s, index) => `
                        <div class="suggestion-card ${index === 0 ? 'top-match' : ''}">
                            <div style="display: flex; justify-content: space-between; align-items: flex-start;">
                                <div>
                                    <div style="display: flex; align-items: center; gap: 0.5rem;">
                                        <strong style="font-size: 1.05rem;">${s.person.name}</strong>
                                        ${index === 0 ? '<span class="badge" style="background: var(--accent); color: white; border: none; font-size: 0.65rem;">BEST MATCH</span>' : ''}
                                        ${s.reason ? '<span class="badge" style="background: #9333ea; color: white; border: none; font-size: 0.6rem;">AI</span>' : ''}
                                    </div>
                                    ${s.reason ? `<div style="font-size: 0.75rem; color: var(--text-secondary); margin-top: 0.2rem;">${s.reason}</div>` : ''}
                                    <div style="font-size: 0.8rem; margin-top: 0.2rem;">
                                        <span class="${s.statusClass}">${s.status}</span> • ${s.score}% Match
                                    </div>
                                </div>
                                <div style="text-align: right;">
                                    <button type="button" class="btn btn-primary" style="padding: 0.4rem 0.8rem; font-size: 0.8rem;" onclick="event.stopPropagation(); window.assignTask('${s.person.id}', '${task.desc.replace(/'/g, "\\'")}', '${task.hours}', '${task.dueDate}', '${task.skills.replace(/'/g, "\\'")}')">
                                        Assign
                                    </button>
                                </div>
                            </div>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
        suggestionContainer.style.display = 'block';
    } else {
        alert("No suitable team members found. Try adjusting the required skills.");
    }
});

// Exposed functions for inline onclicks
window.deletePerson = deletePerson;
window.editPerson = (id) => {
    const p = state.people.find(person => person.id === id);
    openModal(p);
    // Explicitly set capacity for editing because modal uses select
    document.getElementById('p-capacity').value = p.capacity || 40;
};
window.assignTask = assignTask;
window.completeTask = completeTask;
window.deleteTask = deleteTask;
window.updateTaskHours = updateTaskHours;

window.addTrait = (trait) => {
    const input = document.getElementById('p-traits');
    let current = input.value.split(',').map(s => s.trim()).filter(s => s !== '');
    if (!current.includes(trait)) {
        current.push(trait);
        input.value = current.join(', ');
    }
};

window.reAssignTask = (taskId) => {
    const task = state.tasks.find(t => t.id === taskId);
    if (!task) return;

    // Auto-populate the task form
    document.getElementById('task-desc').value = task.desc;
    document.getElementById('task-skills').value = task.skills || ''; // Now preserves skills
    document.getElementById('task-est-hours').value = task.hours;
    document.getElementById('task-due-date').value = task.dueDate || '';

    // Smooth scroll to top
    window.scrollTo({ top: 0, behavior: 'smooth' });

    // Note: We don't delete the orphaned task yet. 
    // It will remain in 'Needs Reassignment' until a new owner is assigned.
};

// --- API Settings ---
document.getElementById('api-settings').addEventListener('click', () => {
    document.getElementById('api-key').value = apiConfig.apiKey;
    document.getElementById('api-model').value = apiConfig.model;
    apiModal.style.display = 'flex';
});

document.getElementById('close-api-modal').addEventListener('click', () => {
    apiModal.style.display = 'none';
});

apiForm.addEventListener('submit', (e) => {
    e.preventDefault();
    apiConfig.apiKey = document.getElementById('api-key').value;
    apiConfig.model = document.getElementById('api-model').value;
    saveApiConfig();
    apiModal.style.display = 'none';
    alert('API settings saved!');
});

// Initialize
const today = new Date().toISOString().split('T')[0];
if (document.getElementById('task-due-date')) {
    document.getElementById('task-due-date').setAttribute('min', today);
}
render();
