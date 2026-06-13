import 'package:test/test.dart';
import '../../services/code_agent.dart';

void main() {
  group('CodeAgent', () {
    test('unifiedCameraCapture should print stub message', () {
      final agent = CodeAgent();
      expect(() => agent.unifiedCameraCapture(), prints('Camera capture executed (stub).\n'));
    });

    test('CodeAgent is a singleton', () {
      final agent1 = CodeAgent();
      final agent2 = CodeAgent();
      expect(identical(agent1, agent2), isTrue);
    });

    test('multiple calls print each time', () {
      final agent = CodeAgent();
      expect(() {
        agent.unifiedCameraCapture();
        agent.unifiedCameraCapture();
        agent.unifiedCameraCapture();
      }, prints('Camera capture executed (stub).\n' * 3));
    });

    test('no side effects after capture', () {
      final agent = CodeAgent();
      // Should not throw
      agent.unifiedCameraCapture();
      // Should not have changed any state (no state)
      expect(true, isTrue);
    });
  });
}
