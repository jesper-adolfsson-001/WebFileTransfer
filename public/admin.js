console.log("Admin JS loaded.");

const tableBody = document.getElementById('log-table-body');
const paginationControls = document.getElementById('pagination-controls');
const limitSelect = document.getElementById('limit');
const errorMessageDiv = document.getElementById('error-message');
const tableHeaders = document.querySelectorAll('#log-table thead th[data-sort]');

// Ensure these are top-level global variables for the script
let currentPage = 1;
let limit = parseInt(limitSelect.value, 10);
let sortBy = 'timestamp';
let sortOrder = 'desc'; // 'asc' or 'desc'
let totalPages = 1;

function formatDate(isoString) {
    // ... (keep existing formatDate)
     if (!isoString) return 'N/A';
    try {
        const date = new Date(isoString);
        return date.toLocaleString(undefined, {
            year: 'numeric', month: 'numeric', day: 'numeric',
            hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: false
        });
    } catch (e) {
        return isoString;
    }
}

function displayError(message) {
    // ... (keep existing displayError)
    errorMessageDiv.textContent = message;
    errorMessageDiv.style.display = 'block';
    tableBody.innerHTML = `<tr><td colspan="5" class="error">Failed to load logs.</td></tr>`;
    paginationControls.innerHTML = '';
}

function clearError() {
    // ... (keep existing clearError)
     errorMessageDiv.style.display = 'none';
}

async function fetchLogs() {
    // Use the global currentPage for the request
    console.log(`fetchLogs: Requesting Page=${currentPage}, Limit=${limit}, Sort=${sortBy}, Order=${sortOrder}`);
    clearError();
    tableBody.innerHTML = `<tr><td colspan="5">Loading logs...</td></tr>`;
    paginationControls.innerHTML = ''; // Clear old pagination before fetch

    // Construct URL using the current global state variables
    const url = `/api/logs?page=${currentPage}&limit=${limit}&sort=${sortBy}&order=${sortOrder}`;

    try {
        const response = await fetch(url);

        // ... (keep existing 401, 404 handling) ...
        if (response.status === 401) {
             displayError("Unauthorized. Please ensure you are logged in correctly.");
             window.location.reload();
             return;
        }
        if (response.status === 404) {
             tableBody.innerHTML = `<tr><td colspan="5">No log file found or no logs yet.</td></tr>`;
             return;
        }
        if (!response.ok) {
            const errorData = await response.text();
            throw new Error(`Failed to fetch logs: ${response.status} ${response.statusText} - ${errorData}`);
        }

        const data = await response.json();
        console.log("fetchLogs: Received API data:", data); // Log the raw response

        if (!data.success) {
            throw new Error(data.message || "API returned unsuccessful status.");
        }

        // --- Update state based on response ---
        // currentPage = data.currentPage; // No! Don't update global from response here, it was set by the click
        totalPages = data.totalPages;

        renderTable(data.logs);
        // Pass the definite current page number FROM THE RESPONSE to renderPagination
        renderPagination(data.currentPage, data.totalPages);
        updateSortIndicators();

    } catch (error) {
        console.error('Error fetching or rendering logs:', error);
        displayError(`Error: ${error.message}`);
    }
}

function renderTable(logs) {
    // ... (keep existing renderTable) ...
     tableBody.innerHTML = '';

    if (!logs || logs.length === 0) {
        tableBody.innerHTML = `<tr><td colspan="5">No logs found for the current selection.</td></tr>`;
        return;
    }

    logs.forEach(log => {
        const row = tableBody.insertRow();
        row.insertCell().textContent = formatDate(log.timestamp);
        row.insertCell().textContent = log.ip || 'N/A';
        row.insertCell().textContent = log.sessionId || 'N/A';
        row.insertCell().textContent = log.action || 'N/A';
        const detailsCell = row.insertCell();
        detailsCell.textContent = log.details ? JSON.stringify(log.details) : 'N/A';
        detailsCell.style.wordBreak = 'break-all';
        detailsCell.style.fontSize = '0.8em';
    });
}

function renderPagination(pageToRenderActive, totalPagesToRender) {
    console.log(`renderPagination: Rendering for page ${pageToRenderActive} of ${totalPagesToRender}`); // Debug render call
    paginationControls.innerHTML = ''; // Clear previous pagination

    if (totalPagesToRender <= 1) {
        return;
    }

    const createButton = (text, pageNumValue, isDisabled = false, isActive = false) => {
        const button = document.createElement('button');
        button.textContent = text;
        button.disabled = isDisabled;
        if (isActive) {
            button.classList.add('active');
        }
        if (!isDisabled && !isActive) {
            button.addEventListener('click', () => {
                // Modify the global currentPage variable
                console.log(`Pagination Click: Button Value=${pageNumValue}, Current Page Before=${currentPage}`);
                if (pageNumValue === 'prev') {
                    if (currentPage > 1) currentPage--;
                } else if (pageNumValue === 'next') {
                    if (currentPage < totalPages) currentPage++;
                } else {
                    currentPage = pageNumValue;
                }
                console.log(`Pagination Click: Current Page After=${currentPage}`);
                fetchLogs(); // Fetch logs based on the NEW global currentPage
            });
        }
        paginationControls.appendChild(button);
    };

    // Previous Button - Disable if on page 1
    createButton('Previous', 'prev', pageToRenderActive === 1);

    // Page Number Buttons Logic (simplified)
    const maxPagesToShow = 5;
    let startPage = Math.max(1, pageToRenderActive - Math.floor(maxPagesToShow / 2));
    let endPage = Math.min(totalPagesToRender, startPage + maxPagesToShow - 1);
    if (endPage === totalPagesToRender) {
        startPage = Math.max(1, totalPagesToRender - maxPagesToShow + 1);
    }

    if (startPage > 1) {
        createButton('1', 1); // Always show page 1
        if (startPage > 2) {
            const ellipsis = document.createElement('span');
            ellipsis.textContent = '...';
            paginationControls.appendChild(ellipsis);
        }
    }

    for (let i = startPage; i <= endPage; i++) {
        createButton(i.toString(), i, false, i === pageToRenderActive); // Active state based on pageToRenderActive
    }

    if (endPage < totalPagesToRender) {
         if (endPage < totalPagesToRender - 1) {
            const ellipsis = document.createElement('span');
            ellipsis.textContent = '...';
            paginationControls.appendChild(ellipsis);
        }
        createButton(totalPagesToRender.toString(), totalPagesToRender); // Always show last page
    }

    // Next Button - Disable if on last page
    createButton('Next', 'next', pageToRenderActive === totalPagesToRender);
}


function updateSortIndicators() {
    // ... (keep existing updateSortIndicators) ...
     tableHeaders.forEach(th => {
        const indicator = th.querySelector('.sort-indicator');
        if (!indicator) return;
        const sortKey = th.getAttribute('data-sort');
        if (sortKey === sortBy) {
            indicator.textContent = sortOrder === 'asc' ? ' ▲' : ' ▼';
        } else {
            indicator.textContent = '';
        }
    });
}

// --- Event Listeners ---

limitSelect.addEventListener('change', (e) => {
    limit = parseInt(e.target.value, 10);
    currentPage = 1; // Reset to first page
    console.log("Limit changed, fetching page 1");
    fetchLogs();
});

tableHeaders.forEach(th => {
    // ... (keep existing sorting listener, ensure it resets currentPage=1 and calls fetchLogs) ...
     const sortKey = th.getAttribute('data-sort');
    if (sortKey) {
        th.style.cursor = 'pointer';
        th.addEventListener('click', () => {
            console.log(`Sort Clicked: Column=${sortKey}, Current Sort=${sortBy}, Current Order=${sortOrder}`);
            if (sortBy === sortKey) {
                sortOrder = sortOrder === 'asc' ? 'desc' : 'asc';
            } else {
                sortBy = sortKey;
                sortOrder = sortBy === 'timestamp' ? 'desc' : 'asc';
            }
             console.log(`Sort Clicked: New Sort=${sortBy}, New Order=${sortOrder}`);
            currentPage = 1; // Reset to first page
            fetchLogs();
        });
    }
});

// --- Initial Load ---
console.log("Initial log fetch");
fetchLogs(); // Call fetchLogs on initial page load