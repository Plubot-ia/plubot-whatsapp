/**
 * Test automatizado para verificar los fixes de la auditoría WhatsApp
 * Valida:
 * 1. Generación correcta del QR
 * 2. Race condition resuelto
 * 3. WebSocket rooms funcionando
 * 4. Session data structure correcta
 */

const axios = require('axios');
const io = require('socket.io-client');
const chalk = require('chalk');

const API_URL = 'http://localhost:3001';
const API_KEY = 'internal-api-key';
const TEST_USER = `test-audit-${Date.now()}`;
const TEST_PLUBOT = '260';

class WhatsAppAuditTest {
  constructor() {
    this.socket = null;
    this.sessionId = `${TEST_USER}-${TEST_PLUBOT}`;
    this.testResults = [];
  }

  log(message, type = 'info') {
    const timestamp = new Date().toISOString();
    const prefix = {
      info: chalk.blue('ℹ'),
      success: chalk.green('✓'),
      error: chalk.red('✗'),
      warning: chalk.yellow('⚠')
    }[type] || '';
    
    console.log(`${prefix} [${timestamp}] ${message}`);
  }

  async runTest(name, testFn) {
    this.log(`Running test: ${name}`, 'info');
    const startTime = Date.now();
    
    try {
      await testFn();
      const duration = Date.now() - startTime;
      this.testResults.push({ name, status: 'PASSED', duration });
      this.log(`Test passed: ${name} (${duration}ms)`, 'success');
      return true;
    } catch (error) {
      const duration = Date.now() - startTime;
      this.testResults.push({ name, status: 'FAILED', duration, error: error.message });
      this.log(`Test failed: ${name} - ${error.message}`, 'error');
      return false;
    }
  }

  async test1_CreateSession() {
    const response = await axios.post(
      `${API_URL}/api/sessions/create`,
      { userId: TEST_USER, plubotId: TEST_PLUBOT },
      { headers: { 'x-api-key': API_KEY } }
    );

    // Verificar estructura de respuesta
    if (!response.data.success) {
      throw new Error('Session creation failed');
    }

    if (!response.data.sessionId) {
      throw new Error('No sessionId in response');
    }

    // Fix #1: Verificar que el QR se genera correctamente
    if (response.data.status === 'waiting_qr') {
      if (!response.data.qr && !response.data.qrDataUrl) {
        throw new Error('RACE CONDITION: QR not generated before response');
      }
    }

    this.log(`Session created: ${response.data.sessionId}`, 'success');
    return response.data;
  }

  async test2_WebSocketConnection() {
    return new Promise((resolve, reject) => {
      this.socket = io(API_URL, {
        transports: ['websocket'],
        reconnection: false
      });

      const timeout = setTimeout(() => {
        reject(new Error('WebSocket connection timeout'));
      }, 5000);

      this.socket.on('connect', () => {
        clearTimeout(timeout);
        this.log(`WebSocket connected: ${this.socket.id}`, 'success');
        
        // Fix #2: Probar ambos eventos de room
        this.socket.emit('subscribe:session', this.sessionId);
        this.socket.emit('join-session', this.sessionId);
        
        resolve();
      });

      this.socket.on('connect_error', (error) => {
        clearTimeout(timeout);
        reject(new Error(`WebSocket connection failed: ${error.message}`));
      });
    });
  }

  async test3_QRGeneration() {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('QR generation timeout - no qr-update event received'));
      }, 15000);

      this.socket.on('qr-update', (data) => {
        clearTimeout(timeout);
        
        // Fix #3: Verificar estructura correcta del QR
        if (!data.qr || !data.qrDataUrl) {
          reject(new Error('Invalid QR data structure'));
          return;
        }

        if (data.qr.length < 100) {
          reject(new Error(`QR too short: ${data.qr.length} chars`));
          return;
        }

        // Fix #4: Verificar que qrDataUrl es base64 válido
        if (!data.qrDataUrl.startsWith('data:image/png;base64,')) {
          reject(new Error('Invalid QR data URL format'));
          return;
        }

        this.log(`QR received: ${data.qr.length} chars`, 'success');
        resolve(data);
      });
    });
  }

  async test4_SessionStatus() {
    const response = await axios.get(
      `${API_URL}/api/sessions/${this.sessionId}/status`,
      { headers: { 'x-api-key': API_KEY } }
    );

    // Fix #5: Verificar estructura de sessionData
    if (!response.data.success) {
      throw new Error('Failed to get session status');
    }

    if (!response.data.status) {
      throw new Error('No status in response');
    }

    // Verificar que el status es correcto
    const validStatuses = ['initializing', 'waiting_qr', 'authenticated', 'ready', 'disconnected'];
    if (!validStatuses.includes(response.data.status)) {
      throw new Error(`Invalid status: ${response.data.status}`);
    }

    this.log(`Session status: ${response.data.status}`, 'success');
    return response.data;
  }

  async test5_DisconnectSession() {
    const response = await axios.post(
      `${API_URL}/api/sessions/${this.sessionId}/disconnect`,
      {},
      { headers: { 'x-api-key': API_KEY } }
    );

    if (!response.data.success) {
      throw new Error('Failed to disconnect session');
    }

    this.log('Session disconnected successfully', 'success');
    return response.data;
  }

  async test6_ConcurrencyTest() {
    // Crear múltiples sesiones simultáneas
    const promises = [];
    const userIds = [];

    for (let i = 0; i < 5; i++) {
      const userId = `concurrent-${Date.now()}-${i}`;
      userIds.push(userId);
      
      promises.push(
        axios.post(
          `${API_URL}/api/sessions/create`,
          { userId, plubotId: TEST_PLUBOT },
          { headers: { 'x-api-key': API_KEY } }
        )
      );
    }

    const results = await Promise.allSettled(promises);
    
    let successCount = 0;
    let queuedCount = 0;
    
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        const data = result.value.data;
        if (data.success) {
          successCount++;
          if (data.queuePosition > 0) {
            queuedCount++;
          }
        }
      }
    });

    // Limpiar sesiones de prueba
    for (const userId of userIds) {
      try {
        await axios.post(
          `${API_URL}/api/sessions/${userId}-${TEST_PLUBOT}/disconnect`,
          {},
          { headers: { 'x-api-key': API_KEY } }
        );
      } catch (e) {
        // Ignorar errores de limpieza
      }
    }

    if (successCount < 5) {
      throw new Error(`Only ${successCount}/5 concurrent sessions created`);
    }

    this.log(`Concurrency test: ${successCount} sessions, ${queuedCount} queued`, 'success');
  }

  async cleanup() {
    if (this.socket) {
      this.socket.disconnect();
    }

    try {
      await axios.post(
        `${API_URL}/api/sessions/${this.sessionId}/disconnect`,
        {},
        { headers: { 'x-api-key': API_KEY } }
      );
    } catch (e) {
      // Ignorar errores de limpieza
    }
  }

  printResults() {
    console.log('\n' + chalk.bold('═══════════════════════════════════════'));
    console.log(chalk.bold('         AUDIT TEST RESULTS'));
    console.log(chalk.bold('═══════════════════════════════════════'));
    
    let passed = 0;
    let failed = 0;
    
    this.testResults.forEach(result => {
      const icon = result.status === 'PASSED' ? chalk.green('✓') : chalk.red('✗');
      const status = result.status === 'PASSED' ? chalk.green(result.status) : chalk.red(result.status);
      console.log(`${icon} ${result.name}: ${status} (${result.duration}ms)`);
      
      if (result.error) {
        console.log(`  └─ ${chalk.red(result.error)}`);
      }
      
      if (result.status === 'PASSED') passed++;
      else failed++;
    });
    
    console.log(chalk.bold('───────────────────────────────────────'));
    console.log(`Total: ${chalk.green(passed + ' passed')}, ${chalk.red(failed + ' failed')}`);
    console.log(chalk.bold('═══════════════════════════════════════\n'));
    
    return failed === 0;
  }

  async run() {
    this.log('Starting WhatsApp Audit Verification Tests', 'info');
    
    try {
      // Test 1: Crear sesión y verificar race condition
      await this.runTest('Create Session (Race Condition Fix)', 
        () => this.test1_CreateSession());
      
      // Test 2: Conectar WebSocket
      await this.runTest('WebSocket Connection', 
        () => this.test2_WebSocketConnection());
      
      // Test 3: Verificar generación de QR
      await this.runTest('QR Generation & Structure', 
        () => this.test3_QRGeneration());
      
      // Test 4: Verificar estado de sesión
      await this.runTest('Session Status Structure', 
        () => this.test4_SessionStatus());
      
      // Test 5: Desconectar sesión
      await this.runTest('Disconnect Session', 
        () => this.test5_DisconnectSession());
      
      // Test 6: Prueba de concurrencia
      await this.runTest('Concurrency & Queue Management', 
        () => this.test6_ConcurrencyTest());
      
    } catch (error) {
      this.log(`Unexpected error: ${error.message}`, 'error');
    } finally {
      await this.cleanup();
    }
    
    const allPassed = this.printResults();
    
    if (allPassed) {
      console.log(chalk.green.bold('🎉 All audit fixes verified successfully!'));
      process.exit(0);
    } else {
      console.log(chalk.red.bold('❌ Some tests failed. Please review the fixes.'));
      process.exit(1);
    }
  }
}

// Ejecutar tests
const tester = new WhatsAppAuditTest();
tester.run().catch(error => {
  console.error(chalk.red('Fatal error:'), error);
  process.exit(1);
});
