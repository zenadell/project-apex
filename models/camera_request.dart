class CameraRequest {
  final int id;
  final DateTime requestTime;
  final String status;

  CameraRequest({
    required this.id,
    required this.requestTime,
    required this.status,
  });

  factory CameraRequest.fromMap(Map<String, dynamic> map) {
    return CameraRequest(
      id: map['id'] as int,
      requestTime: map['request_time'] as DateTime,
      status: map['status'] as String,
    );
  }

  Map<String, dynamic> toMap() {
    return {
      'id': id,
      'request_time': requestTime,
      'status': status,
    };
  }
}
