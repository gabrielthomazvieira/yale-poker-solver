document.addEventListener('DOMContentLoaded', async () => {
  const result = await window.electronAPI.getConfigData();
  const form = document.getElementById('config-form');
  form.innerHTML = '';

  if (result.success) {
    const configData = result.data;  // full JSON object

    const hiddenSolverKeys = [
      'allinThreshold', 'buildTree', 'useIsomorphism', 'startSolve',
      'printInterval', 'threadCount'
    ];

    // Helper to create form elements recursively or for specific sections
    const createFormSection = (title, data, parentPath = '') => {
      const sectionDiv = document.createElement('div');
      sectionDiv.classList.add('config-section');
      const heading = document.createElement('h3');
      heading.textContent = title;
      sectionDiv.appendChild(heading);

      for (const key in data) {
        if (!Object.prototype.hasOwnProperty.call(data, key)) continue;

        if (parentPath === 'solverSettings' && hiddenSolverKeys.includes(key)) {
          console.log(`Hiding solver setting: ${key}`);
          continue;
        }

        const value = data[key];
        const currentPath = parentPath ? `${parentPath}.${key}` : key;

        // Skip complex nested objects like betSizing here, handle separately
        if (typeof value === 'object' && !Array.isArray(value) &&
            key !== 'betSizing') {
          console.warn(`Skipping complex object rendering for key: ${key}`);
          continue;
        }
        if (Array.isArray(value) &&
            key !==
                'betSizing') {  // Keep betSizing arrays for later processing
          console.warn(`Skipping array rendering for key: ${key}`);
          continue;
        }

        const itemDiv = document.createElement('div');
        itemDiv.classList.add('config-item');

        const label = document.createElement('label');
        label.textContent =
            key.replace(/([A-Z])/g, ' $1')
                .replace(/^./, str => str.toUpperCase())
                .trim();  // e.g., effectiveStack -> Effective Stack
        itemDiv.appendChild(label);


        if (key === 'inPosition' || key === 'outOfPosition') {
          const input = document.createElement('input');
          input.type = 'text';
          input.value = value || '';
          input.dataset.path = currentPath;  // Store JSON path
          itemDiv.appendChild(input);

          const rangeType = key === 'inPosition' ? 'ip' : 'oop';
          const editButton = document.createElement('button');
          editButton.textContent = 'Edit Range';
          editButton.type = 'button';
          editButton.style.marginLeft = '10px';
          editButton.style.padding = '5px 10px';
          editButton.classList.add('edit-range-btn');
          editButton.addEventListener('click', () => {
            const currentRangeString = input.value;
            window.electronAPI.openRangeEditor(
                {rangeType, initialRangeString: currentRangeString});
          });
          itemDiv.appendChild(editButton);

        } else if (key === 'betSizing') {
          // Handle betSizing structure separately
          const betSizingContainer = document.createElement('div');
          betSizingContainer.classList.add('bet-sizing-section');
          handleBetSizing(
              value, betSizingContainer, currentPath);  // Pass path prefix
          itemDiv.appendChild(
              betSizingContainer);  // Append the whole bet sizing section

        } else {
          const input = document.createElement('input');
          if (typeof value === 'boolean') {
            input.type = 'checkbox';
            input.checked = value;
          } else if (typeof value === 'number') {
            input.type = 'number';
            if (!Number.isInteger(value)) {
              input.step = '0.01';
            }
            input.value = value;
          } else {
            input.type = 'text';
            input.value = value || '';
          }
          input.dataset.path = currentPath;
          itemDiv.appendChild(input);
        }

        sectionDiv.appendChild(itemDiv);
      }
      form.appendChild(sectionDiv);
    };

    // Recursive helper specifically for the betSizing structure
    const handleBetSizing =
        (betSizingData, container, basePath) => {
          for (const position in betSizingData) {  // ip, oop
            const positionDiv = document.createElement('div');
            positionDiv.classList.add('bet-sizing-position');
            const posHeading = document.createElement('h3');
            posHeading.textContent =
                position === 'inPosition' ? 'In Position' : 'Out of Position';
            positionDiv.appendChild(posHeading);

            for (const street in
                 betSizingData[position]) {  // flop, turn, river
              const streetDiv = document.createElement('div');
              streetDiv.classList.add('bet-sizing-street');
              const streetHeading = document.createElement('h4');
              streetHeading.textContent =
                  street.charAt(0).toUpperCase() + street.slice(1);
              streetDiv.appendChild(streetHeading);

              betSizingData[position][street].forEach(
                  (actionObj, index) => {  // Array of {action, sizes}
                    const action = actionObj.action;
                    if (action === 'allin') {
                      console.log(`Hiding bet size action: ${position}/${
                          street}/allin`);
                      return;
                    }
                    const sizes = actionObj.sizes;
                    const currentPath = `${basePath}.${position}.${street}.${
                        index}.sizes`;  // Path to the sizes array

                    const itemDiv = document.createElement('div');
                    itemDiv.classList.add('config-item', 'bet-size-item');

                    const label = document.createElement('label');
                    label.textContent =
                        action.charAt(0).toUpperCase() + action.slice(1);
                    itemDiv.appendChild(label);

                    const input = document.createElement('input');
                    input.type = 'text';
                    input.value = sizes.join(',');
                    input.dataset.path = currentPath;
                    itemDiv.appendChild(input);
                    streetDiv.appendChild(itemDiv);
                  });
              positionDiv.appendChild(streetDiv);
            }
            container.appendChild(positionDiv);
          }
        }

    if (configData.gameSetup) {
      createFormSection('Game Setup', configData.gameSetup, 'gameSetup');
    }
    if (configData.playerRanges) {
      createFormSection(
          'Player Ranges', configData.playerRanges, 'playerRanges');
    }
    if (configData.betSizing) {
      const betSizingSectionDiv = document.createElement('div');
      betSizingSectionDiv.classList.add('config-section');
      const betSizingHeading = document.createElement('h3');
      betSizingHeading.textContent = 'Bet Sizing';
      betSizingSectionDiv.appendChild(betSizingHeading);
      handleBetSizing(configData.betSizing, betSizingSectionDiv, 'betSizing');
      form.appendChild(betSizingSectionDiv);
    }
    if (configData.solverSettings) {
      createFormSection(
          'Solver Settings', configData.solverSettings, 'solverSettings');
    }
  } else {
    console.error(
        'Error fetching configuration:',
        result.error || 'Unknown error, data might be missing.');
    const errorP = document.createElement('p');
    errorP.textContent = 'Error fetching configuration: ' +
        (result.error || 'Received invalid data from main process.');
    errorP.style.color = 'red';
    form.appendChild(errorP);
    alert(
        'Error fetching configuration: ' +
        (result.error ||
         'Received invalid data from main process. Check console.'));
  }
});

window.electronAPI.onUpdateConfigRangeField((data) => {
  const {rangeType, rangeString} = data;
  // Construct the expected JSON path
  const targetPath = rangeType === 'ip' ? 'playerRanges.inPosition' :
                                          'playerRanges.outOfPosition';
  // Find the input element using the data-path attribute
  const inputElement =
      document.querySelector(`input[data-path="${targetPath}"]`);

  if (inputElement) {
    inputElement.value = rangeString;
  } else {
    console.warn(`Could not find input element for path: ${targetPath}`);
  }
});


document.getElementById('apply-config-btn')
    .addEventListener('click', async () => {
      const inputs = document.querySelectorAll('#config-form input[data-path]');
      const newConfigs = {};

      inputs.forEach(input => {
        const path = input.dataset.path;
        if (path) {
          if (input.type === 'checkbox') {
            newConfigs[path] = input.checked;
          } else {
            newConfigs[path] = input.value.trim();
          }
        }
      });

      console.log('Applying configurations:', newConfigs);

      const result = await window.electronAPI.applyConfigurations(newConfigs);
      if (result.success) {
        alert(result.message || 'Configurations applied successfully.');
        window.close();
      } else {
        alert('Error applying configurations: ' + result.error);
      }
    });