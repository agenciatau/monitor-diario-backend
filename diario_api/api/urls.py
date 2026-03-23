from django.urls import path
from .views import ChatView, UploadView

urlpatterns = [
    path("chat/", ChatView.as_view(), name="chat"),
    path("upload/", UploadView.as_view(), name="upload"),
]
